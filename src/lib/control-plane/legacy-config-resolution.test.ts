import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  applyLegacyConfigResolution,
  legacyResolutionReasonCodesDigest,
  validateLegacyResolutionDispositions,
  type LegacyResolutionBinding,
} from "@/lib/control-plane/legacy-config-resolution";
import type { LegacyTransformResult } from "@/lib/control-plane/legacy-shadow";
import { LEGACY_TRANSFORM_VERSION } from "@/lib/control-plane/legacy-sources";

const SOURCE_SHA = "a".repeat(40);
const INPUT_DIGEST = "b".repeat(64);
const CENTRAL_DIGEST = "c".repeat(64);
const CONFIG_ID = "active-config";

function transform(
  code: "SECRET_LIKE_KEY" | "NO_REPRESENTABLE_SOURCE" | "SOURCE_PARSE_ERROR",
): LegacyTransformResult {
  return {
    status: "DRAFTABLE_WITH_INPUT",
    transformVersion: LEGACY_TRANSFORM_VERSION,
    inputDigest: "d".repeat(64),
    payload: { schemaVersion: 1, markets: [] },
    payloadDigest: "e".repeat(64),
    coverage: {
      status: "COMPLETE",
      expected: 7,
      reported: 7,
      present: code === "NO_REPRESENTABLE_SOURCE" ? 0 : 1,
      absent: code === "NO_REPRESENTABLE_SOURCE" ? 7 : 6,
      readable: code === "NO_REPRESENTABLE_SOURCE" ? 0 : 1,
      transformable: 0,
      blocked: code === "NO_REPRESENTABLE_SOURCE" ? 0 : 1,
    },
    reasons: [{ code, path: "$", sourceKind: code === "NO_REPRESENTABLE_SOURCE" ? undefined : "APP_STORE_CONFIG" }],
  };
}

function binding(code: "SECRET_LIKE_KEY" | "NO_REPRESENTABLE_SOURCE"): LegacyResolutionBinding {
  return {
    id: "resolution-1",
    appId: "app-1",
    sourceSha: SOURCE_SHA,
    transformVersion: LEGACY_TRANSFORM_VERSION,
    inputDigest: INPUT_DIGEST,
    reasonCodesDigest: legacyResolutionReasonCodesDigest([code]),
    configRevisionId: CONFIG_ID,
    centralStateDigest: CENTRAL_DIGEST,
    resolutionDigest: "f".repeat(64),
  };
}

test("reason digest는 순서와 중복에 영향받지 않는다", () => {
  assert.equal(
    legacyResolutionReasonCodesDigest(["SECRET_LIKE_KEY", "UNSUPPORTED_FIELD"]),
    legacyResolutionReasonCodesDigest(["UNSUPPORTED_FIELD", "SECRET_LIKE_KEY", "SECRET_LIKE_KEY"]),
  );
});

test("secret reason은 사람 승인과 CredentialBinding 공개 증거를 모두 요구한다", () => {
  assert.deepEqual(validateLegacyResolutionDispositions({
    reasonCodes: ["SECRET_LIKE_KEY"],
    dispositions: [{ reasonCode: "SECRET_LIKE_KEY", targets: ["CREDENTIAL_BINDING"] }],
    evidenceKinds: new Set(),
    approvalKind: "HUMAN",
  }), { ok: false, code: "LEGACY_RESOLUTION_EVIDENCE_MISSING" });
  assert.deepEqual(validateLegacyResolutionDispositions({
    reasonCodes: ["SECRET_LIKE_KEY"],
    dispositions: [{ reasonCode: "SECRET_LIKE_KEY", targets: ["CREDENTIAL_BINDING"] }],
    evidenceKinds: new Set(["CREDENTIAL_BINDING"]),
    approvalKind: "HUMAN",
  }), { ok: true });
  assert.deepEqual(validateLegacyResolutionDispositions({
    reasonCodes: ["SECRET_LIKE_KEY"],
    dispositions: [{ reasonCode: "SECRET_LIKE_KEY", targets: ["CREDENTIAL_BINDING"] }],
    evidenceKinds: new Set(["CREDENTIAL_BINDING"]),
    approvalKind: "AUTOMATION",
  }), { ok: false, code: "LEGACY_RESOLUTION_HUMAN_APPROVAL_REQUIRED" });
});

test("자동 승인은 legacy desired state가 전혀 없는 exact source만 허용한다", () => {
  assert.deepEqual(validateLegacyResolutionDispositions({
    reasonCodes: ["NO_REPRESENTABLE_SOURCE"],
    dispositions: [{ reasonCode: "NO_REPRESENTABLE_SOURCE", targets: ["IGNORED_NON_OPERATIONAL"] }],
    evidenceKinds: new Set(["CONFIG_REVISION"]),
    approvalKind: "AUTOMATION",
  }), { ok: true });
});

test("source parse와 provenance 계열 오류는 resolution으로 우회할 수 없다", () => {
  const parseError = transform("SOURCE_PARSE_ERROR");
  assert.deepEqual(validateLegacyResolutionDispositions({
    reasonCodes: parseError.reasons.map((reason) => reason.code),
    dispositions: [],
    evidenceKinds: new Set(),
    approvalKind: "HUMAN",
  }), { ok: false, code: "LEGACY_RESOLUTION_REASON_NOT_RESOLVABLE" });
  for (const code of ["INVALID_SOURCE_SHAPE", "INVALID_DESIRED_STATE"] as const) {
    assert.deepEqual(validateLegacyResolutionDispositions({
      reasonCodes: [code],
      dispositions: [],
      evidenceKinds: new Set(),
      approvalKind: "HUMAN",
    }), { ok: false, code: "LEGACY_RESOLUTION_REASON_NOT_RESOLVABLE" });
  }
});

test("resolution은 source, reason, ACTIVE config, 중앙 상태가 모두 exact일 때만 MATCH한다", () => {
  const legacy = transform("SECRET_LIKE_KEY");
  const resolution = binding("SECRET_LIKE_KEY");
  const matched = applyLegacyConfigResolution({
    transform: legacy,
    persistedInputDigest: INPUT_DIGEST,
    sourceSha: SOURCE_SHA,
    configRevisionId: CONFIG_ID,
    centralPayload: { schemaVersion: 1, markets: [] },
    centralStateDigest: CENTRAL_DIGEST,
    resolution,
  });
  assert.equal(matched?.status, "MATCH");
  assert.equal(matched?.legacyDigest, matched?.centralDigest);
  assert.equal(applyLegacyConfigResolution({
    transform: legacy,
    persistedInputDigest: INPUT_DIGEST,
    sourceSha: "9".repeat(40),
    configRevisionId: CONFIG_ID,
    centralPayload: { schemaVersion: 1, markets: [] },
    centralStateDigest: CENTRAL_DIGEST,
    resolution,
  }), null);
  assert.equal(applyLegacyConfigResolution({
    transform: legacy,
    persistedInputDigest: INPUT_DIGEST,
    sourceSha: SOURCE_SHA,
    configRevisionId: CONFIG_ID,
    centralPayload: { schemaVersion: 1, markets: [] },
    centralStateDigest: "8".repeat(64),
    resolution,
  }), null);
});

test("승인은 legacy가 구조화한 안전한 값을 중앙에서 바꾸는 권한이 아니다", () => {
  const legacy: LegacyTransformResult = {
    status: "DRAFTABLE_WITH_INPUT",
    transformVersion: LEGACY_TRANSFORM_VERSION,
    inputDigest: "d".repeat(64),
    payload: {
      schemaVersion: 1,
      markets: [{
        market: "google-play",
        enabled: true,
        locales: ["ko-KR"],
        releaseChannel: "internal",
      }],
    },
    payloadDigest: "e".repeat(64),
    coverage: transform("SECRET_LIKE_KEY").coverage,
    reasons: [{ code: "SECRET_LIKE_KEY", path: "$", sourceKind: "APP_STORE_CONFIG" }],
  };
  const mismatch = applyLegacyConfigResolution({
    transform: legacy,
    persistedInputDigest: INPUT_DIGEST,
    sourceSha: SOURCE_SHA,
    configRevisionId: CONFIG_ID,
    centralPayload: {
      schemaVersion: 1,
      markets: [{ market: "google-play", enabled: false, locales: ["ko-KR", "en-US"] }],
    },
    centralStateDigest: CENTRAL_DIGEST,
    resolution: binding("SECRET_LIKE_KEY"),
  });
  assert.equal(mismatch?.status, "MISMATCH");
  assert.ok(mismatch?.diffs.some((diff) => diff.code === "VALUE_MISMATCH"));

  const centralSuperset = applyLegacyConfigResolution({
    transform: legacy,
    persistedInputDigest: INPUT_DIGEST,
    sourceSha: SOURCE_SHA,
    configRevisionId: CONFIG_ID,
    centralPayload: {
      schemaVersion: 1,
      markets: [
        {
          market: "google-play",
          enabled: true,
          locales: ["ko-KR", "en-US"],
          releaseChannel: "internal",
        },
        {
          market: "app-store",
          enabled: true,
          locales: ["ko-KR"],
          releaseChannel: "testflight",
        },
      ],
      support: { supportUrl: "https://example.invalid/support" },
    },
    centralStateDigest: CENTRAL_DIGEST,
    resolution: binding("SECRET_LIKE_KEY"),
  });
  assert.equal(centralSuperset?.status, "MATCH");
});

test("DB/API 경계에는 raw legacy field나 secret export 컬럼이 없다", () => {
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const model = schema.match(/model LegacyConfigResolution \{[\s\S]*?\n\}/)?.[0] ?? "";
  const service = readFileSync(
    join(process.cwd(), "src/lib/control-plane/legacy-config-resolution-service.ts"),
    "utf8",
  );
  assert.doesNotMatch(model, /^\s*(content|rawContent|fieldPath|secret|password|credentialValue)\s+/m);
  assert.match(model, /sourceSha\s+String/);
  assert.match(model, /centralStateDigest\s+String/);
  assert.match(service, /approvalKind: LegacyResolutionApprovalKind/);
  assert.equal(existsSync(join(
    process.cwd(),
    "src/app/api/control-plane/legacy-config-resolutions/route.ts",
  )), true);
});
