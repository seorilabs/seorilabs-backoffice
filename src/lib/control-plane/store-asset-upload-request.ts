import {
  storeAssetUploadMetadataSchema,
  type StoreAssetUploadMetadata,
} from "@/lib/control-plane/contracts";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { MAX_STORE_ASSET_BYTES } from "@/lib/control-plane/store-asset-upload";

type StoreAssetMetadataField = "repoId" | "expectedLatestRevision" | "market" | "kind" | "locale";

// ingress(25 MiB)보다 작고 file 원본 상한(20 MiB)보다 큰 multipart 전체 body 상한이다.
// Content-Length가 없거나 chunked인 내부 요청도 stream을 직접 계수해 같은 상한을 적용한다.
export const MAX_STORE_ASSET_MULTIPART_BYTES = 21 * 1_024 * 1_024;

interface StoreAssetUploadRequest {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

function multipartError(message: string, status = 400, code = "STORE_ASSET_MULTIPART_INVALID") {
  return new ControlPlaneError(message, status, code);
}

function declaredBodyLength(headers: Headers): number | null {
  const value = headers.get("content-length")?.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) {
    throw multipartError("StoreAsset Content-Length가 유효하지 않습니다.");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw multipartError("StoreAsset Content-Length가 유효하지 않습니다.");
  }
  return length;
}

async function readBoundedMultipartBody(request: StoreAssetUploadRequest): Promise<ArrayBuffer> {
  const declared = declaredBodyLength(request.headers);
  if (declared !== null && declared > MAX_STORE_ASSET_MULTIPART_BYTES) {
    throw multipartError(
      `StoreAsset multipart body는 ${MAX_STORE_ASSET_MULTIPART_BYTES} bytes 이하여야 합니다.`,
      413,
      "STORE_ASSET_MULTIPART_TOO_LARGE",
    );
  }
  if (!request.body) {
    throw multipartError("StoreAsset multipart body가 필요합니다.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_STORE_ASSET_MULTIPART_BYTES) {
        try {
          await reader.cancel("store asset multipart body limit exceeded");
        } catch {
          // provider stream의 cancel 실패가 bounded rejection을 바꾸지 않게 한다.
        }
        throw multipartError(
          `StoreAsset multipart body는 ${MAX_STORE_ASSET_MULTIPART_BYTES} bytes 이하여야 합니다.`,
          413,
          "STORE_ASSET_MULTIPART_TOO_LARGE",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw multipartError("StoreAsset multipart body를 읽을 수 없습니다.");
  } finally {
    reader.releaseLock();
  }

  if (total === 0) throw multipartError("StoreAsset multipart body가 필요합니다.");
  const body = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export async function parseStoreAssetUploadRequest(
  request: StoreAssetUploadRequest,
  repoIdOverride?: bigint,
): Promise<{
  metadata: StoreAssetUploadMetadata;
  data: Uint8Array;
  declaredContentType: string;
}> {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw multipartError(
      "StoreAsset upload는 multipart/form-data여야 합니다.",
      415,
      "STORE_ASSET_MULTIPART_REQUIRED",
    );
  }
  const body = await readBoundedMultipartBody(request);
  let formData: FormData;
  try {
    formData = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw multipartError("StoreAsset multipart body를 읽을 수 없습니다.");
  }
  return parseStoreAssetUploadFormData(formData, repoIdOverride);
}

export function isTrustedStoreAssetUiOrigin(input: {
  requestUrl: string;
  origin: string | null;
  authUrl?: string;
  nodeEnv?: string;
}): boolean {
  const configured = input.authUrl?.trim();
  const supplied = input.origin?.trim();
  if (!configured || !supplied) return false;
  try {
    const expected = new URL(configured);
    if (input.nodeEnv === "production" && expected.protocol !== "https:") return false;
    return new URL(supplied).origin === expected.origin
      && new URL(input.requestUrl).origin === expected.origin;
  } catch {
    return false;
  }
}

function singleText(formData: FormData, field: StoreAssetMetadataField): string | undefined {
  const values = formData.getAll(field);
  const raw = values[0];
  if (values.length > 1 || (values.length === 1 && typeof raw !== "string")) {
    throw new ControlPlaneError(
      `StoreAsset ${field} 필드는 문자열 하나여야 합니다.`,
      400,
      "STORE_ASSET_MULTIPART_INVALID",
    );
  }
  const value = typeof raw === "string" ? raw.trim() : undefined;
  return value ? value : undefined;
}

export async function parseStoreAssetUploadFormData(
  formData: FormData,
  repoIdOverride?: bigint,
): Promise<{
  metadata: StoreAssetUploadMetadata;
  data: Uint8Array;
  declaredContentType: string;
}> {
  const allowedFields = new Set<string>([
    "expectedLatestRevision",
    "market",
    "kind",
    "locale",
    "file",
    ...(repoIdOverride === undefined ? ["repoId"] : []),
  ]);
  const unknown = [...new Set(formData.keys())].filter((field) => !allowedFields.has(field));
  if (unknown.length > 0) {
    throw new ControlPlaneError(
      `허용되지 않은 StoreAsset multipart field입니다: ${unknown.join(", ")}`,
      400,
      "STORE_ASSET_MULTIPART_INVALID",
    );
  }

  const files = formData.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof Blob)) {
    throw new ControlPlaneError(
      "StoreAsset file 하나가 필요합니다.",
      400,
      "STORE_ASSET_FILE_REQUIRED",
    );
  }
  const file = files[0];
  if (file.size === 0 || file.size > MAX_STORE_ASSET_BYTES) {
    throw new ControlPlaneError(
      `StoreAsset 크기는 1~${MAX_STORE_ASSET_BYTES} bytes여야 합니다.`,
      413,
      "STORE_ASSET_FILE_SIZE_INVALID",
    );
  }

  const metadata = storeAssetUploadMetadataSchema.parse({
    repoId: repoIdOverride ?? singleText(formData, "repoId"),
    expectedLatestRevision: singleText(formData, "expectedLatestRevision"),
    market: singleText(formData, "market"),
    kind: singleText(formData, "kind"),
    locale: singleText(formData, "locale"),
  });
  return {
    metadata,
    data: new Uint8Array(await file.arrayBuffer()),
    declaredContentType: file.type,
  };
}
