import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  recordFleetParityImport,
  type FleetParityImportDependencies,
} from "@/lib/control-plane/fleet-parity-import";
import { legacyResolutionReasonCodesDigest } from "@/lib/control-plane/legacy-config-resolution";
import { LEGACY_SOURCE_DEFINITIONS, LEGACY_TRANSFORM_VERSION } from "@/lib/control-plane/legacy-sources";
import { ControlPlaneError } from "@/lib/control-plane/service";

type ImportResult = Awaited<ReturnType<FleetParityImportDependencies["recordImport"]>>;
type ImportInput = Parameters<FleetParityImportDependencies["recordImport"]>[0];
type ResolutionInput = Parameters<FleetParityImportDependencies["recordResolution"]>[0];

const SOURCE_SHA = "a".repeat(40);
const INPUT = {
  repoId: 123n,
  sourceSha: SOURCE_SHA,
  observedBy: "backoffice:fleet-parity",
  idempotencyKey: "fleet-parity:wave:result",
};

function fixture(): ImportResult {
  const observedAt = new Date("2026-09-02T00:00:00.000Z");
  const parity = {
    id: "parity-first",
    configRevisionId: "active-config-3",
    sourceSha: SOURCE_SHA,
    scope: "FULL",
    contractVersion: LEGACY_TRANSFORM_VERSION,
    status: "NEEDS_INPUT" as const,
    legacyDigest: null,
    centralDigest: null,
    diff: [{ path: "$", code: "NO_REPRESENTABLE_SOURCE" }],
    legacyConfigResolutionId: null,
    observedBy: INPUT.observedBy,
    observedAt,
  };
  return {
    import: {
      id: "legacy-import-first",
      appId: "app-123",
      sourceSha: SOURCE_SHA,
      sourceRef: "refs/heads/main",
      transformVersion: LEGACY_TRANSFORM_VERSION,
      inputDigest: "b".repeat(64),
      reasonCodes: ["NO_REPRESENTABLE_SOURCE"],
      reasonCodesDigest: legacyResolutionReasonCodesDigest(["NO_REPRESENTABLE_SOURCE"]),
      status: "DRAFT_CREATED_WITH_INPUT",
      configRevisionId: null,
      observedBy: INPUT.observedBy,
      observedAt,
      createdAt: observedAt,
      configRevision: null,
      sources: LEGACY_SOURCE_DEFINITIONS.map((source) => ({
        id: `source-${source.sourceKind}`,
        repoId: source.repositoryScope === "APP" ? "123" : "456",
        repoFullName: source.repositoryScope === "APP" ? "seorilabs/test-app" : "seorilabs/platform",
        sourceSha: source.repositoryScope === "APP" ? SOURCE_SHA : "c".repeat(40),
        sourceRef: "refs/heads/main",
        sourceKind: source.sourceKind,
        path: source.pathPattern.replace("*", "test-app"),
        blobSha: null,
        contentSha256: null,
        status: "ABSENT",
        transformVersion: LEGACY_TRANSFORM_VERSION,
        parsedPayloadHash: null,
        errorCode: "PATH_NOT_FOUND",
        observedAt,
      })),
      parityObservations: [parity],
    },
    configRevision: null,
    parity,
    sourceCount: LEGACY_SOURCE_DEFINITIONS.length,
    duplicate: false,
  };
}

function harness(first = fixture(), second = fixture()) {
  const imports: ImportInput[] = [];
  const resolutions: ResolutionInput[] = [];
  let applicable = false;
  let contextReads = 0;
  const dependencies: FleetParityImportDependencies = {
    recordImport: async (input) => {
      imports.push(input);
      return input.idempotencyKey.startsWith("fleet-no-legacy-recheck:") ? second : first;
    },
    readCurrentContext: async () => {
      contextReads += 1;
      return { activeConfigRevision: 3, latestResolutionRevision: 1 };
    },
    hasApplicableResolution: async () => applicable,
    recordResolution: async (input) => {
      resolutions.push(input);
      applicable = true;
    },
  };
  return {
    dependencies,
    imports,
    resolutions,
    contextReads: () => contextReads,
    markApplicable: () => { applicable = true; },
  };
}

test("전체 legacy 파일 부재는 기존 validator로 기록한 뒤 별도 source 관측 결과를 반환한다", async () => {
  const first = fixture();
  const second = fixture();
  second.parity!.id = "parity-fresh-readback";
  const h = harness(first, second);
  assert.equal(await recordFleetParityImport(INPUT, h.dependencies), second);
  assert.equal(h.imports.length, 2);
  assert.equal(h.resolutions.length, 1);
  assert.deepEqual(h.resolutions[0].request, {
    schemaVersion: 1,
    repoId: INPUT.repoId,
    legacyImportId: first.import.id,
    expectedResolutionRevision: 1,
    expectedActiveConfigRevision: 3,
    dispositions: [{ reasonCode: "NO_REPRESENTABLE_SOURCE", targets: ["IGNORED_NON_OPERATIONAL"] }],
    justification: "NO_LEGACY_DESIRED_STATE",
  });
  assert.equal(h.resolutions[0].approvalKind, "AUTOMATION");
  assert.equal(h.resolutions[0].actor, INPUT.observedBy);
  assert.match(h.resolutions[0].idempotencyKey, /^fleet-no-legacy:[0-9a-f]{64}$/);
  assert.match(h.imports[1].idempotencyKey, /^fleet-no-legacy-recheck:[0-9a-f]{64}$/);
  assert.equal(second.parity!.status, "NEEDS_INPUT");
});

const rejectedCases: Array<[string, (result: ImportResult) => void]> = [
  ["사람 검토 reason 혼합", (result) => { result.import.reasonCodes = ["NO_REPRESENTABLE_SOURCE", "LEGAL_COMPLIANCE_AMBIGUITY"]; }],
  ["법적 선언", (result) => { result.import.reasonCodes = ["LEGAL_COMPLIANCE_AMBIGUITY"]; }],
  ["마켓 상태", (result) => { result.import.reasonCodes = ["PROVIDER_STATE_AMBIGUITY"]; }],
  ["reason digest 불일치", (result) => { result.import.reasonCodesDigest = "d".repeat(64); }],
  ["부분 source count", (result) => { result.sourceCount -= 1; }],
  ["부분 source 목록", (result) => { result.import.sources.pop(); }],
  ["중복 source kind", (result) => { result.import.sources[0].sourceKind = result.import.sources[1].sourceKind; }],
  ["존재하는 legacy 파일", (result) => { result.import.sources[0].status = "PRESENT"; }],
  ["읽을 수 없는 legacy 파일", (result) => { result.import.sources[0].status = "ACCESS_DENIED"; }],
  ["source 오류", (result) => { result.import.sources[0].errorCode = "SOURCE_READ_UNAVAILABLE"; }],
  ["부재 원인 미확인", (result) => { result.import.sources[0].errorCode = null; }],
  ["다른 source SHA", (result) => { result.import.sourceSha = "e".repeat(40); }],
  ["다른 비교 source SHA", (result) => { result.parity!.sourceSha = "e".repeat(40); }],
  ["다른 transform 계약", (result) => { result.import.transformVersion = "legacy-config-v0"; }],
  ["부분 비교 scope", (result) => { result.parity!.scope = "PARTIAL"; }],
  ["적용 설정 없음", (result) => { result.parity!.configRevisionId = null; }],
  ["기존 MATCH", (result) => { result.parity!.status = "MATCH"; }],
];

for (const [name, mutate] of rejectedCases) {
  test(`${name}: 자동 판정으로 승격하지 않는다`, async () => {
    const first = fixture();
    mutate(first);
    const h = harness(first);
    assert.equal(await recordFleetParityImport(INPUT, h.dependencies), first);
    assert.equal(h.imports.length, 1);
    assert.equal(h.resolutions.length, 0);
    assert.equal(h.contextReads(), 0);
  });
}

test("source 또는 ACTIVE 설정이 바뀌면 자동 기록 전에 중단한다", async () => {
  const h = harness();
  h.dependencies.readCurrentContext = async () => null;
  await assert.rejects(recordFleetParityImport(INPUT, h.dependencies), (error: unknown) => (
    error instanceof ControlPlaneError && error.code === "SOURCE_VECTOR_CHANGED"
  ));
  assert.equal(h.resolutions.length, 0);
  assert.equal(h.imports.length, 1);
});

test("기존 exact 판정이 있으면 새 판정을 쓰지 않고 source만 다시 확인한다", async () => {
  const h = harness();
  h.markApplicable();
  await recordFleetParityImport(INPUT, h.dependencies);
  assert.equal(h.resolutions.length, 0);
  assert.equal(h.imports.length, 2);
});

test("중단 뒤 같은 실행을 재개해도 판정과 recheck idempotency가 유지된다", async () => {
  const h = harness();
  await recordFleetParityImport(INPUT, h.dependencies);
  await recordFleetParityImport(INPUT, h.dependencies);
  assert.equal(h.resolutions.length, 1);
  assert.equal(h.imports.length, 4);
  assert.equal(h.imports[1].idempotencyKey, h.imports[3].idempotencyKey);
});

for (const code of ["IDEMPOTENCY_CONFLICT", "LEGACY_RESOLUTION_REVISION_CONFLICT"]) {
  test(`${code}는 승자의 exact 판정 readback이 있을 때만 이어간다`, async () => {
    const h = harness();
    let attempted = 0;
    h.dependencies.recordResolution = async () => {
      attempted += 1;
      h.markApplicable();
      throw new ControlPlaneError("동시 실행", 409, code);
    };
    await recordFleetParityImport(INPUT, h.dependencies);
    assert.equal(attempted, 1);
    assert.equal(h.imports.length, 2);
  });
}

test("동시 판정 충돌의 승자를 확인할 수 없으면 쓰기를 반복하지 않는다", async () => {
  const h = harness();
  let attempted = 0;
  h.dependencies.recordResolution = async () => {
    attempted += 1;
    throw new ControlPlaneError("동시 실행", 409, "LEGACY_RESOLUTION_REVISION_CONFLICT");
  };
  await assert.rejects(recordFleetParityImport(INPUT, h.dependencies), /동시 실행/);
  assert.equal(attempted, 1);
  assert.equal(h.imports.length, 1);
});

test("결과 불명인 저장 오류는 새 mutation이나 성공 판정으로 덮지 않는다", async () => {
  const h = harness();
  h.dependencies.recordResolution = async () => {
    h.markApplicable();
    throw new Error("RESULT_UNKNOWN");
  };
  await assert.rejects(recordFleetParityImport(INPUT, h.dependencies), /RESULT_UNKNOWN/);
  assert.equal(h.imports.length, 1);
});

test("판정 후 source 재조회 실패를 성공으로 바꾸지 않는다", async () => {
  const h = harness();
  const original = h.dependencies.recordImport;
  h.dependencies.recordImport = async (input) => {
    if (input.idempotencyKey.startsWith("fleet-no-legacy-recheck:")) {
      throw new ControlPlaneError("소스 변경", 409, "SOURCE_SHA_CHANGED_DURING_READ");
    }
    return original(input);
  };
  await assert.rejects(recordFleetParityImport(INPUT, h.dependencies), /소스 변경/);
  assert.equal(h.resolutions.length, 1);
});

test("전체 비교 기본 실행이 자동 부재 판정 연결을 사용한다", () => {
  const service = readFileSync(join(process.cwd(), "src/lib/control-plane/fleet-parity-service.ts"), "utf8");
  assert.match(service, /recordImport: \(input\) => recordFleetParityImport\(input\)/);
});
