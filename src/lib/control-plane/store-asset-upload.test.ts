import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { automationMutationRequestHash } from "@/lib/control-plane/automation-mutation";
import { type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import {
  buildStoreAssetObjectKey,
  GoogleCloudStoreAssetObjectStore,
  type StoreAssetObjectReadback,
  type StoreAssetObjectStore,
  type StoreAssetUploadDependencies,
  uploadStoreAsset,
} from "@/lib/control-plane/store-asset-upload";
import {
  isTrustedStoreAssetUiOrigin,
  MAX_STORE_ASSET_MULTIPART_BYTES,
  parseStoreAssetUploadFormData,
  parseStoreAssetUploadRequest,
} from "@/lib/control-plane/store-asset-upload-request";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("store-asset-fixture"),
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0xff, 0xd9]);

class MemoryObjectStore implements StoreAssetObjectStore {
  readonly objects = new Map<string, StoreAssetObjectReadback>();
  puts = 0;
  reads = 0;
  tamperChecksum = false;

  async putIfAbsent(input: {
    objectKey: string;
    data: Uint8Array;
    contentType: "image/png" | "image/jpeg";
    customMetadata: Record<string, string>;
  }): Promise<{ created: boolean }> {
    this.puts += 1;
    if (this.objects.has(input.objectKey)) return { created: false };
    this.objects.set(input.objectKey, {
      data: Buffer.from(input.data),
      metadata: {
        generation: "101",
        sizeBytes: input.data.byteLength,
        contentType: input.contentType,
        custom: { ...input.customMetadata },
      },
    });
    return { created: true };
  }

  async read(objectKey: string): Promise<StoreAssetObjectReadback> {
    this.reads += 1;
    const stored = this.objects.get(objectKey);
    assert.ok(stored);
    const data = Buffer.from(stored.data);
    if (this.tamperChecksum) data[data.length - 1] = data[data.length - 1]! ^ 0xff;
    return {
      data,
      metadata: {
        ...stored.metadata,
        custom: { ...stored.metadata.custom },
      },
    };
  }
}

function dependencies(store = new MemoryObjectStore(), revisions: number[] = [7]): {
  deps: StoreAssetUploadDependencies;
  store: MemoryObjectStore;
  audits: Array<{ action: string; entityType: string; entityId?: string | null }>;
} {
  const mutations = new Map<string, {
    actor: string;
    operation: string;
    targetKey: string;
    requestHash: string;
    response: JsonValue | null;
  }>();
  const audits: Array<{ action: string; entityType: string; entityId?: string | null }> = [];
  let contextRead = 0;
  return {
    store,
    audits,
    deps: {
      async readContext(repoId) {
        const revision = revisions[Math.min(contextRead, revisions.length - 1)]!;
        contextRead += 1;
        return { appId: "app-1", repoId, latestRevision: revision };
      },
      async beginMutation(input) {
        const requestHash = automationMutationRequestHash(input);
        const existing = mutations.get(input.requestId);
        if (!existing) {
          mutations.set(input.requestId, {
            actor: input.actor,
            operation: input.operation,
            targetKey: input.targetKey,
            requestHash,
            response: null,
          });
          return { requestHash, replay: null };
        }
        if (
          existing.actor !== input.actor
          || existing.operation !== input.operation
          || existing.targetKey !== input.targetKey
          || existing.requestHash !== requestHash
        ) {
          throw new ControlPlaneError("conflict", 409, "IDEMPOTENCY_CONFLICT");
        }
        return { requestHash, replay: existing.response };
      },
      async completeMutation(input) {
        const existing = mutations.get(input.requestId);
        assert.ok(existing);
        assert.equal(existing.requestHash, input.requestHash);
        if (existing.response !== null) return existing.response;
        const response = JSON.parse(JSON.stringify(input.response)) as JsonValue;
        existing.response = response;
        audits.push(input.audit);
        return response;
      },
      objectStore: () => store,
      now: () => new Date("2026-08-30T07:00:00.000Z"),
    },
  };
}

function uploadInput(data: Uint8Array = PNG) {
  return {
    metadata: {
      repoId: 123456789n,
      expectedLatestRevision: 7,
      market: "google-play" as const,
      kind: "icon" as const,
      locale: "ko",
    },
    data,
    declaredContentType: "image/png",
    actor: "magicsih",
    idempotencyKey: "store-asset:test-1",
  };
}

test("deterministic key는 numeric app identity와 revision/market/locale에 고정된다", () => {
  const checksum = "a".repeat(64);
  assert.equal(buildStoreAssetObjectKey({
    repoId: 123456789n,
    configRevision: 8,
    market: "google-play",
    locale: "ko",
    kind: "icon",
    checksum,
    extension: "png",
  }), `apps/123456789/revisions/8/markets/google-play/locales/ko/icon/${checksum}.png`);
});

test("upload 뒤 object bytes를 다시 읽어 SHA-256을 검증하고 mutation audit를 한 번만 봉인한다", async () => {
  const fixture = dependencies();
  const first = await uploadStoreAsset(uploadInput(), fixture.deps);
  const checksum = crypto.createHash("sha256").update(PNG).digest("hex");
  assert.equal(first.duplicate, false);
  assert.equal(first.receipt.checksum, checksum);
  assert.equal(first.receipt.configRevision, 8);
  assert.equal(first.receipt.generation, "101");
  assert.equal(first.receipt.created, true);
  assert.equal(fixture.store.puts, 1);
  assert.equal(fixture.store.reads, 1);
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0]?.action, "control-plane.store-asset.upload");
  assert.equal(fixture.audits[0]?.entityType, "StoreAssetObject");
  assert.equal(fixture.audits[0]?.entityId, first.receipt.objectKey);

  const replay = await uploadStoreAsset(uploadInput(), fixture.deps);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(fixture.store.puts, 1, "완료된 idempotency replay는 upload를 반복하지 않는다");
  assert.equal(fixture.store.reads, 2, "replay도 현재 object readback을 다시 검증한다");
  assert.equal(fixture.audits.length, 1);
});

test("같은 idempotent request 두 개가 동시에 실행돼도 created와 receipt가 완료 순서에 흔들리지 않는다", async () => {
  let releaseCreator: (() => void) | null = null;
  const creatorCanContinue = new Promise<void>((resolve) => {
    releaseCreator = resolve;
  });
  class ReorderedObjectStore extends MemoryObjectStore {
    override async putIfAbsent(input: {
      objectKey: string;
      data: Uint8Array;
      contentType: "image/png" | "image/jpeg";
      customMetadata: Record<string, string>;
    }): Promise<{ created: boolean }> {
      this.puts += 1;
      if (this.objects.has(input.objectKey)) {
        releaseCreator?.();
        return { created: false };
      }
      this.objects.set(input.objectKey, {
        data: Buffer.from(input.data),
        metadata: {
          generation: "101",
          sizeBytes: input.data.byteLength,
          contentType: input.contentType,
          custom: { ...input.customMetadata },
        },
      });
      await creatorCanContinue;
      return { created: true };
    }
  }
  const fixture = dependencies(new ReorderedObjectStore());
  const [first, second] = await Promise.all([
    uploadStoreAsset(uploadInput(), fixture.deps),
    uploadStoreAsset(uploadInput(), fixture.deps),
  ]);
  assert.deepEqual(first.receipt, second.receipt);
  assert.equal(first.receipt.created, true);
  assert.equal(fixture.store.puts, 2);
  assert.equal(fixture.audits.length, 1);
});

test("다른 idempotency request가 같은 content-addressed object를 재사용하면 created=false다", async () => {
  const fixture = dependencies();
  const first = await uploadStoreAsset(uploadInput(), fixture.deps);
  const second = await uploadStoreAsset({
    ...uploadInput(),
    idempotencyKey: "store-asset:test-2",
  }, fixture.deps);
  assert.equal(first.receipt.created, true);
  assert.equal(second.receipt.created, false);
  assert.equal(fixture.store.objects.size, 1);
  assert.equal(fixture.audits.length, 2);
});

test("object upload 뒤 complete CAS가 실패해도 같은 request retry가 overwrite 없이 완료된다", async () => {
  const fixture = dependencies();
  const complete = fixture.deps.completeMutation;
  let failComplete = true;
  fixture.deps.completeMutation = async (input) => {
    if (failComplete) {
      failComplete = false;
      throw new ControlPlaneError("simulated CAS interruption", 409, "MUTATION_CAS_CONFLICT");
    }
    return complete(input);
  };
  await assert.rejects(
    () => uploadStoreAsset(uploadInput(), fixture.deps),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "MUTATION_CAS_CONFLICT",
  );
  const retry = await uploadStoreAsset(uploadInput(), fixture.deps);
  assert.equal(retry.duplicate, false);
  assert.equal(retry.receipt.created, true);
  assert.equal(fixture.store.puts, 2);
  assert.equal(fixture.store.objects.size, 1);
  assert.equal(fixture.audits.length, 1);
});

test("object readback bytes가 달라지면 mutation 완료와 audit를 fail-closed한다", async () => {
  const fixture = dependencies();
  fixture.store.tamperChecksum = true;
  await assert.rejects(
    () => uploadStoreAsset(uploadInput(), fixture.deps),
    (error: unknown) => error instanceof ControlPlaneError
      && error.code === "STORE_ASSET_READBACK_CHECKSUM_MISMATCH",
  );
  assert.equal(fixture.audits.length, 0);
});

test("같은 Idempotency-Key를 다른 asset bytes에 재사용하면 upload 전에 거부한다", async () => {
  const fixture = dependencies();
  await uploadStoreAsset(uploadInput(), fixture.deps);
  await assert.rejects(
    () => uploadStoreAsset({
      ...uploadInput(JPEG),
      declaredContentType: "image/jpeg",
    }, fixture.deps),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(fixture.store.puts, 1);
  assert.equal(fixture.audits.length, 1);
});

test("upload 도중 ConfigRevision optimistic concurrency가 바뀌면 receipt를 확정하지 않는다", async () => {
  const fixture = dependencies(new MemoryObjectStore(), [7, 7, 8]);
  await assert.rejects(
    () => uploadStoreAsset(uploadInput(), fixture.deps),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "CONFIG_REVISION_CONFLICT",
  );
  assert.equal(fixture.audits.length, 0);
  assert.equal(fixture.store.objects.size, 1, "create-only object는 drift 뒤 즉시 삭제하지 않는다");
});

test("multipart parser는 unknown/repeated field와 repo identity 바꿔치기를 거부한다", async () => {
  const valid = new FormData();
  valid.set("expectedLatestRevision", "7");
  valid.set("market", "app-store");
  valid.set("kind", "screenshot");
  valid.set("locale", "en-US");
  valid.set("file", new Blob([PNG], { type: "image/png" }), "shot.png");
  const parsed = await parseStoreAssetUploadFormData(valid, 123456789n);
  assert.equal(parsed.metadata.repoId, 123456789n);
  assert.equal(parsed.data.byteLength, PNG.byteLength);

  const forged = new FormData();
  for (const [key, value] of valid.entries()) forged.append(key, value);
  forged.set("repoId", "999");
  await assert.rejects(
    () => parseStoreAssetUploadFormData(forged, 123456789n),
    (error: unknown) => error instanceof ControlPlaneError
      && error.code === "STORE_ASSET_MULTIPART_INVALID",
  );
});

test("multipart 전체 body는 Content-Length 유무와 chunked 여부와 무관하게 상한을 적용한다", async () => {
  await assert.rejects(
    () => parseStoreAssetUploadRequest({
      headers: new Headers({
        "content-type": "multipart/form-data; boundary=asset",
        "content-length": String(MAX_STORE_ASSET_MULTIPART_BYTES + 1),
      }),
      body: null,
    }),
    (error: unknown) => error instanceof ControlPlaneError
      && error.code === "STORE_ASSET_MULTIPART_TOO_LARGE",
  );

  let chunks = 0;
  let canceled = false;
  const oneMiB = new Uint8Array(1_024 * 1_024);
  const chunkedBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks += 1;
      controller.enqueue(oneMiB);
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(
    () => parseStoreAssetUploadRequest({
      headers: new Headers({
        "content-type": "multipart/form-data; boundary=asset",
        "transfer-encoding": "chunked",
      }),
      body: chunkedBody,
    }),
    (error: unknown) => error instanceof ControlPlaneError
      && error.code === "STORE_ASSET_MULTIPART_TOO_LARGE",
  );
  assert.equal(chunks, 22);
  assert.equal(canceled, true);
});

test("Content-Length 없는 정상 multipart도 bounded reader 뒤 공통 validator로 처리한다", async () => {
  const formData = new FormData();
  formData.set("expectedLatestRevision", "7");
  formData.set("kind", "icon");
  formData.set("file", new Blob([PNG], { type: "image/png" }), "icon.png");
  const request = new Request("https://backoffice.example/api/platform/apps/app-1/store-assets", {
    method: "POST",
    body: formData,
  });
  assert.equal(request.headers.has("content-length"), false);
  const parsed = await parseStoreAssetUploadRequest(request, 123456789n);
  assert.equal(parsed.metadata.repoId, 123456789n);
  assert.deepEqual(Buffer.from(parsed.data), PNG);
});

test("UI origin은 AUTH_URL과 실제 request URL이 모두 일치해야 하며 production HTTP는 거부한다", () => {
  assert.equal(isTrustedStoreAssetUiOrigin({
    requestUrl: "https://attacker.example/api/platform/apps/app-1/store-assets",
    origin: "https://attacker.example",
    nodeEnv: "production",
  }), false);
  assert.equal(isTrustedStoreAssetUiOrigin({
    requestUrl: "https://attacker.example/api/platform/apps/app-1/store-assets",
    origin: "https://backoffice.example",
    authUrl: "https://backoffice.example",
    nodeEnv: "production",
  }), false);
  assert.equal(isTrustedStoreAssetUiOrigin({
    requestUrl: "https://backoffice.example/api/platform/apps/app-1/store-assets",
    origin: "https://backoffice.example",
    authUrl: "https://backoffice.example",
    nodeEnv: "production",
  }), true);
  assert.equal(isTrustedStoreAssetUiOrigin({
    requestUrl: "http://backoffice.example/api/platform/apps/app-1/store-assets",
    origin: "http://backoffice.example",
    authUrl: "http://backoffice.example",
    nodeEnv: "production",
  }), false);
});

test("Google Cloud adapter는 CRC32C와 create-only generation precondition을 사용한다", async () => {
  const saves: Array<Record<string, unknown>> = [];
  const downloads: Array<{ validation: "crc32c" }> = [];
  const custom = { sha256: "a".repeat(64) };
  const bucket = {
    file(_name: string, options?: { generation?: string | number }) {
      return {
        async save(_data: Uint8Array, saveOptions: Record<string, unknown>) {
          saves.push(saveOptions);
        },
        async getMetadata() {
          return [{ generation: "44", size: PNG.byteLength, contentType: "image/png", metadata: custom }] as [{
            generation: string;
            size: number;
            contentType: string;
            metadata: typeof custom;
          }];
        },
        async download(downloadOptions: { validation: "crc32c" }) {
          assert.equal(options?.generation, "44");
          downloads.push(downloadOptions);
          return [PNG] as [Buffer];
        },
      };
    },
  };
  const adapter = new GoogleCloudStoreAssetObjectStore(bucket);
  assert.deepEqual(await adapter.putIfAbsent({
    objectKey: "asset.png",
    data: PNG,
    contentType: "image/png",
    customMetadata: custom,
  }), { created: true });
  assert.deepEqual(saves[0]?.preconditionOpts, { ifGenerationMatch: 0 });
  assert.equal(saves[0]?.validation, "crc32c");
  const readback = await adapter.read("asset.png");
  assert.equal(readback.metadata.generation, "44");
  assert.deepEqual(downloads, [{ validation: "crc32c" }]);
});

test("internal/UI route는 공통 service 앞에서 각각 workload auth와 app RBAC를 강제한다", () => {
  const internalRoute = readFileSync(
    join(process.cwd(), "src/app/api/control-plane/store-assets/route.ts"),
    "utf8",
  );
  const uiRoute = readFileSync(
    join(process.cwd(), "src/app/api/platform/apps/[appId]/store-assets/route.ts"),
    "utf8",
  );
  const service = readFileSync(
    join(process.cwd(), "src/lib/control-plane/store-asset-upload.ts"),
    "utf8",
  );
  assert.match(internalRoute, /authenticateInternalRequest\(request, "control-plane"\)/);
  assert.match(internalRoute, /requireIdempotencyKey\(request\)/);
  assert.match(internalRoute, /parseStoreAssetUploadRequest\(request\)/);
  assert.match(uiRoute, /isTrustedStoreAssetUiOrigin/);
  assert.match(uiRoute, /requirePlatformWriteAccess\(app\.slug\)/);
  assert.match(uiRoute, /parseStoreAssetUploadRequest\(request, app\.repoId\)/);
  assert.match(service, /beginAutomationMutation/);
  assert.match(service, /completeAutomationMutation/);
  assert.match(service, /control-plane\.store-asset\.upload/);
});
