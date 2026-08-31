import crypto from "node:crypto";

import {
  Storage,
  type DownloadOptions,
  type FileOptions,
  type SaveOptions,
} from "@google-cloud/storage";
import { z } from "zod";

import {
  storeAssetUploadMetadataSchema,
  type StoreAssetUploadMetadata,
} from "@/lib/control-plane/contracts";
import {
  beginAutomationMutation,
  completeAutomationMutation,
} from "@/lib/control-plane/automation-mutation";
import { type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

export const MAX_STORE_ASSET_BYTES = 20 * 1_024 * 1_024;

const storeAssetBucketNameSchema = z.string().regex(
  /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/,
  "유효한 Google Cloud Storage bucket 이름이 필요합니다.",
);
const publicActorSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,190}$/);
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:/-]{8,191}$/);

const storeAssetUploadReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.string().min(1).max(191),
  repoId: z.string().regex(/^\d{1,30}$/),
  configRevision: z.number().int().positive(),
  market: z.enum(["google-play", "app-store", "apps-in-toss"]).nullable(),
  locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).nullable(),
  kind: z.enum(["icon", "feature-graphic", "thumbnail", "screenshot"]),
  objectKey: z.string().min(1).max(191),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.enum(["image/png", "image/jpeg"]),
  sizeBytes: z.number().int().positive().max(MAX_STORE_ASSET_BYTES),
  generation: z.string().regex(/^[1-9]\d*$/),
  created: z.boolean(),
  verifiedAt: z.string().datetime(),
}).strict();

export type StoreAssetUploadReceipt = z.infer<typeof storeAssetUploadReceiptSchema>;

interface StoreAssetObjectMetadata {
  generation: string;
  sizeBytes: number;
  contentType: string;
  custom: Record<string, string>;
}

export interface StoreAssetObjectReadback {
  data: Uint8Array;
  metadata: StoreAssetObjectMetadata;
}

export interface StoreAssetObjectStore {
  putIfAbsent(input: {
    objectKey: string;
    data: Uint8Array;
    contentType: "image/png" | "image/jpeg";
    customMetadata: Record<string, string>;
  }): Promise<{ created: boolean }>;
  read(objectKey: string): Promise<StoreAssetObjectReadback>;
}

interface GcsMetadata {
  generation?: string | number;
  size?: string | number;
  contentType?: string;
  metadata?: Record<string, string | boolean | number | null>;
}

interface GcsFileLike {
  save(data: Uint8Array, options: Record<string, unknown>): Promise<void>;
  getMetadata(): Promise<[GcsMetadata, unknown?]>;
  download(options: { validation: "crc32c" }): Promise<[Buffer]>;
}

interface GcsBucketLike {
  file(name: string, options?: { generation?: string | number }): GcsFileLike;
}

function isPreconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === 412 || code === "412";
}

/**
 * Google 공식 SDK의 CRC32C 검증과 generation precondition을 사용한다.
 * 객체가 이미 있으면 덮어쓰지 않고 이후 readback에서 동일 bytes인지 검증한다.
 */
export class GoogleCloudStoreAssetObjectStore implements StoreAssetObjectStore {
  constructor(private readonly bucket: GcsBucketLike) {}

  async putIfAbsent(input: {
    objectKey: string;
    data: Uint8Array;
    contentType: "image/png" | "image/jpeg";
    customMetadata: Record<string, string>;
  }): Promise<{ created: boolean }> {
    try {
      const saveOptions = {
        resumable: input.data.byteLength >= 10 * 1_024 * 1_024,
        validation: "crc32c",
        contentType: input.contentType,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: input.contentType,
          cacheControl: "private, no-store, max-age=0",
          metadata: input.customMetadata,
        },
      } satisfies SaveOptions;
      await this.bucket.file(input.objectKey).save(input.data, saveOptions);
      return { created: true };
    } catch (error) {
      if (isPreconditionFailed(error)) return { created: false };
      throw error;
    }
  }

  async read(objectKey: string): Promise<StoreAssetObjectReadback> {
    const current = this.bucket.file(objectKey);
    const [metadata] = await current.getMetadata();
    const generation = String(metadata.generation ?? "");
    const sizeBytes = Number(metadata.size);
    if (!/^[1-9]\d*$/.test(generation) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new ControlPlaneError(
        "StoreAsset object metadata를 검증할 수 없습니다.",
        502,
        "STORE_ASSET_READBACK_METADATA_INVALID",
      );
    }
    const versionedFileOptions = { generation } satisfies FileOptions;
    const downloadOptions = { validation: "crc32c" } satisfies DownloadOptions;
    const [data] = await this.bucket.file(objectKey, versionedFileOptions).download(downloadOptions);
    const custom = Object.fromEntries(Object.entries(metadata.metadata ?? {}).flatMap(([key, value]) => (
      value === null || value === undefined ? [] : [[key, String(value)]]
    )));
    return {
      data,
      metadata: {
        generation,
        sizeBytes,
        contentType: metadata.contentType ?? "",
        custom,
      },
    };
  }
}

let cachedObjectStore: { bucketName: string; store: StoreAssetObjectStore } | null = null;

function configuredObjectStore(): StoreAssetObjectStore {
  const bucketName = storeAssetBucketNameSchema.safeParse(
    process.env.CONTROL_PLANE_STORE_ASSET_BUCKET?.trim() ?? "",
  );
  if (!bucketName.success) {
    throw new ControlPlaneError(
      "중앙 StoreAsset bucket이 설정되지 않았습니다.",
      503,
      "STORE_ASSET_STORAGE_NOT_CONFIGURED",
    );
  }
  if (cachedObjectStore?.bucketName === bucketName.data) return cachedObjectStore.store;
  const bucket = new Storage().bucket(bucketName.data) as unknown as GcsBucketLike;
  const store = new GoogleCloudStoreAssetObjectStore(bucket);
  cachedObjectStore = { bucketName: bucketName.data, store };
  return store;
}

interface StoreAssetMutationIdentity {
  requestId: string;
  actor: string;
  operation: string;
  targetKey: string;
  request: JsonValue;
}

interface StoreAssetUploadContext {
  appId: string;
  repoId: bigint;
  latestRevision: number;
}

export interface StoreAssetUploadDependencies {
  readContext(repoId: bigint): Promise<StoreAssetUploadContext>;
  beginMutation(input: StoreAssetMutationIdentity): Promise<{
    requestHash: string;
    replay: JsonValue | null;
  }>;
  completeMutation(input: StoreAssetMutationIdentity & {
    requestHash: string;
    response: unknown;
    audit: {
      action: string;
      entityType: string;
      entityId?: string | null;
      payload?: JsonValue;
    };
  }): Promise<JsonValue>;
  objectStore(): StoreAssetObjectStore;
  now(): Date;
}

const defaultDependencies: StoreAssetUploadDependencies = {
  async readContext(repoId) {
    const app = await prisma.app.findUnique({
      where: { repoId },
      select: { id: true, repoId: true },
    });
    if (!app?.repoId) {
      throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
    }
    const latest = await prisma.configRevision.aggregate({
      where: { appId: app.id },
      _max: { revision: true },
    });
    return {
      appId: app.id,
      repoId: app.repoId,
      latestRevision: latest._max.revision ?? 0,
    };
  },
  beginMutation: beginAutomationMutation,
  completeMutation: completeAutomationMutation,
  objectStore: configuredObjectStore,
  now: () => new Date(),
};

function detectImage(data: Uint8Array): {
  contentType: "image/png" | "image/jpeg";
  extension: "png" | "jpg";
} {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.byteLength >= pngSignature.length
    && pngSignature.every((value, index) => data[index] === value)) {
    return { contentType: "image/png", extension: "png" };
  }
  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  throw new ControlPlaneError(
    "StoreAsset은 PNG 또는 JPEG 원본만 업로드할 수 있습니다.",
    400,
    "STORE_ASSET_FILE_TYPE_UNSUPPORTED",
  );
}

function normalizedDeclaredContentType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

export function buildStoreAssetObjectKey(input: {
  repoId: bigint;
  configRevision: number;
  market?: StoreAssetUploadMetadata["market"];
  locale?: string;
  kind: StoreAssetUploadMetadata["kind"];
  checksum: string;
  extension: "png" | "jpg";
}): string {
  const objectKey = [
    "apps",
    input.repoId.toString(),
    "revisions",
    String(input.configRevision),
    "markets",
    input.market ?? "all",
    "locales",
    input.locale ?? "all",
    input.kind,
    `${input.checksum}.${input.extension}`,
  ].join("/");
  if (objectKey.length > 191) {
    throw new ControlPlaneError(
      "StoreAsset deterministic object key가 저장 계약 길이를 초과했습니다.",
      400,
      "STORE_ASSET_OBJECT_KEY_TOO_LONG",
    );
  }
  return objectKey;
}

function assertExpectedRevision(context: StoreAssetUploadContext, expectedLatestRevision: number): void {
  if (context.latestRevision !== expectedLatestRevision) {
    throw new ControlPlaneError(
      `Config revision 충돌: expected=${expectedLatestRevision}, actual=${context.latestRevision}`,
      409,
      "CONFIG_REVISION_CONFLICT",
    );
  }
}

function sha256(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function assertReceiptIdentity(
  receipt: StoreAssetUploadReceipt,
  expected: {
    appId: string;
    repoId: bigint;
    configRevision: number;
    metadata: StoreAssetUploadMetadata;
    objectKey: string;
    checksum: string;
    contentType: "image/png" | "image/jpeg";
    sizeBytes: number;
  },
): void {
  if (
    receipt.appId !== expected.appId
    || receipt.repoId !== expected.repoId.toString()
    || receipt.configRevision !== expected.configRevision
    || receipt.market !== (expected.metadata.market ?? null)
    || receipt.locale !== (expected.metadata.locale ?? null)
    || receipt.kind !== expected.metadata.kind
    || receipt.objectKey !== expected.objectKey
    || receipt.checksum !== expected.checksum
    || receipt.contentType !== expected.contentType
    || receipt.sizeBytes !== expected.sizeBytes
  ) {
    throw new ControlPlaneError(
      "저장된 StoreAsset upload receipt가 현재 요청과 일치하지 않습니다.",
      409,
      "STORE_ASSET_RECEIPT_IDENTITY_MISMATCH",
    );
  }
}

function assertReadback(input: {
  readback: StoreAssetObjectReadback;
  appId: string;
  repoId: bigint;
  configRevision: number;
  metadata: StoreAssetUploadMetadata;
  checksum: string;
  contentType: "image/png" | "image/jpeg";
  sizeBytes: number;
}): void {
  const { readback } = input;
  const expectedMetadata = {
    appId: input.appId,
    repoId: input.repoId.toString(),
    configRevision: String(input.configRevision),
    market: input.metadata.market ?? "all",
    locale: input.metadata.locale ?? "all",
    kind: input.metadata.kind,
    sha256: input.checksum,
  };
  const creationRequestDigest = readback.metadata.custom.creationRequestDigest ?? "";
  if (
    readback.metadata.sizeBytes !== input.sizeBytes
    || readback.data.byteLength !== input.sizeBytes
    || readback.metadata.contentType !== input.contentType
    || Object.entries(expectedMetadata).some(([key, value]) => readback.metadata.custom[key] !== value)
    || !/^[0-9a-f]{64}$/.test(creationRequestDigest)
  ) {
    throw new ControlPlaneError(
      "업로드한 StoreAsset의 object metadata readback이 요청과 일치하지 않습니다.",
      502,
      "STORE_ASSET_READBACK_METADATA_MISMATCH",
    );
  }
  if (sha256(readback.data) !== input.checksum) {
    throw new ControlPlaneError(
      "업로드한 StoreAsset의 SHA-256 readback 검증에 실패했습니다.",
      502,
      "STORE_ASSET_READBACK_CHECKSUM_MISMATCH",
    );
  }
}

function objectCreatedByRequest(
  readback: StoreAssetObjectReadback,
  creationRequestDigest: string,
): boolean {
  return readback.metadata.custom.creationRequestDigest === creationRequestDigest;
}

async function readObject(
  objectStore: StoreAssetObjectStore,
  objectKey: string,
): Promise<StoreAssetObjectReadback> {
  try {
    return await objectStore.read(objectKey);
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError(
      "중앙 StoreAsset object readback에 실패했습니다.",
      503,
      "STORE_ASSET_STORAGE_UNAVAILABLE",
    );
  }
}

export async function uploadStoreAsset(input: {
  metadata: StoreAssetUploadMetadata;
  data: Uint8Array;
  declaredContentType: string;
  actor: string;
  idempotencyKey: string;
}, dependencies: StoreAssetUploadDependencies = defaultDependencies): Promise<{
  duplicate: boolean;
  receipt: StoreAssetUploadReceipt;
}> {
  const metadata = storeAssetUploadMetadataSchema.parse(input.metadata);
  const actor = publicActorSchema.parse(input.actor);
  const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
  if (input.data.byteLength === 0 || input.data.byteLength > MAX_STORE_ASSET_BYTES) {
    throw new ControlPlaneError(
      `StoreAsset 크기는 1~${MAX_STORE_ASSET_BYTES} bytes여야 합니다.`,
      413,
      "STORE_ASSET_FILE_SIZE_INVALID",
    );
  }
  const data = Buffer.from(input.data);
  const detected = detectImage(data);
  const declaredContentType = normalizedDeclaredContentType(input.declaredContentType);
  if (declaredContentType && declaredContentType !== detected.contentType) {
    throw new ControlPlaneError(
      "선언된 content type과 실제 StoreAsset bytes가 일치하지 않습니다.",
      400,
      "STORE_ASSET_CONTENT_TYPE_MISMATCH",
    );
  }
  const checksum = sha256(data);
  const creationRequestDigest = sha256(Buffer.from(idempotencyKey, "utf8"));
  const firstContext = await dependencies.readContext(metadata.repoId);
  assertExpectedRevision(firstContext, metadata.expectedLatestRevision);
  const configRevision = metadata.expectedLatestRevision + 1;
  const objectKey = buildStoreAssetObjectKey({
    repoId: metadata.repoId,
    configRevision,
    market: metadata.market,
    locale: metadata.locale,
    kind: metadata.kind,
    checksum,
    extension: detected.extension,
  });
  const request = {
    schemaVersion: 1,
    appId: firstContext.appId,
    repoId: metadata.repoId.toString(),
    expectedLatestRevision: metadata.expectedLatestRevision,
    configRevision,
    market: metadata.market ?? null,
    locale: metadata.locale ?? null,
    kind: metadata.kind,
    objectKey,
    checksum,
    contentType: detected.contentType,
    sizeBytes: data.byteLength,
  } satisfies JsonValue;
  const identity: StoreAssetMutationIdentity = {
    requestId: idempotencyKey,
    actor,
    operation: "STORE_ASSET_UPLOAD",
    targetKey: `store-asset:${objectKey}`,
    request,
  };
  const mutation = await dependencies.beginMutation(identity);
  const objectStore = dependencies.objectStore();

  if (mutation.replay !== null) {
    const receipt = storeAssetUploadReceiptSchema.parse(mutation.replay);
    assertReceiptIdentity(receipt, {
      appId: firstContext.appId,
      repoId: metadata.repoId,
      configRevision,
      metadata,
      objectKey,
      checksum,
      contentType: detected.contentType,
      sizeBytes: data.byteLength,
    });
    const readback = await readObject(objectStore, objectKey);
    assertReadback({
      readback,
      appId: firstContext.appId,
      repoId: metadata.repoId,
      configRevision,
      metadata,
      checksum,
      contentType: detected.contentType,
      sizeBytes: data.byteLength,
    });
    if (
      receipt.generation !== readback.metadata.generation
      || receipt.created !== objectCreatedByRequest(readback, creationRequestDigest)
    ) {
      throw new ControlPlaneError(
        "저장된 StoreAsset upload receipt가 현재 object generation과 일치하지 않습니다.",
        409,
        "STORE_ASSET_RECEIPT_IDENTITY_MISMATCH",
      );
    }
    return { duplicate: true, receipt };
  }

  assertExpectedRevision(await dependencies.readContext(metadata.repoId), metadata.expectedLatestRevision);
  let readback: StoreAssetObjectReadback;
  try {
    await objectStore.putIfAbsent({
      objectKey,
      data,
      contentType: detected.contentType,
      customMetadata: {
        appId: firstContext.appId,
        repoId: metadata.repoId.toString(),
        configRevision: String(configRevision),
        market: metadata.market ?? "all",
        locale: metadata.locale ?? "all",
        kind: metadata.kind,
        sha256: checksum,
        creationRequestDigest,
      },
    });
    readback = await readObject(objectStore, objectKey);
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError(
      "중앙 StoreAsset object storage 요청에 실패했습니다.",
      503,
      "STORE_ASSET_STORAGE_UNAVAILABLE",
    );
  }
  assertReadback({
    readback,
    appId: firstContext.appId,
    repoId: metadata.repoId,
    configRevision,
    metadata,
    checksum,
    contentType: detected.contentType,
    sizeBytes: data.byteLength,
  });
  assertExpectedRevision(await dependencies.readContext(metadata.repoId), metadata.expectedLatestRevision);

  const receipt: StoreAssetUploadReceipt = {
    schemaVersion: 1,
    appId: firstContext.appId,
    repoId: metadata.repoId.toString(),
    configRevision,
    market: metadata.market ?? null,
    locale: metadata.locale ?? null,
    kind: metadata.kind,
    objectKey,
    checksum,
    contentType: detected.contentType,
    sizeBytes: data.byteLength,
    generation: readback.metadata.generation,
    // HTTP attempt 순서가 아니라 이 idempotent logical request가 객체를
    // 최초 생성했는지를 object metadata로 결정해 concurrent retry도 동일하게 응답한다.
    created: objectCreatedByRequest(readback, creationRequestDigest),
    verifiedAt: dependencies.now().toISOString(),
  };
  const completed = await dependencies.completeMutation({
    ...identity,
    requestHash: mutation.requestHash,
    response: receipt,
    audit: {
      action: "control-plane.store-asset.upload",
      entityType: "StoreAssetObject",
      entityId: objectKey,
      payload: request,
    },
  });
  return {
    duplicate: false,
    receipt: storeAssetUploadReceiptSchema.parse(completed),
  };
}
