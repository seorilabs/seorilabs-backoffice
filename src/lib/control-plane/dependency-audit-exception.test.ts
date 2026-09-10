import assert from "node:assert/strict";
import test from "node:test";

import { configRevisionPayloadSchema, dependencyAuditExceptionSchema } from "@/lib/control-plane/contracts";

const SOURCE_SHA = "229ecf91a82c58f9ad03b6eb0fa7c6cf1621d678";
const LOCKFILE = "sha256:cb5b76ffefde7230fc26709dee426979a79de2953649d235343a1b44742b32df";

function exception(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    repositoryId: "1335099739",
    fullName: "seorilabs/saju-reader",
    bindings: [
      { actionClass: "STATIC_CHECK", sourceSha: SOURCE_SHA, lockfileSha256: LOCKFILE },
      { actionClass: "ANDROID_BUILD_ONLY", sourceSha: SOURCE_SHA, lockfileSha256: LOCKFILE },
    ],
    expiresAt: "2026-10-03T00:00:00Z",
    reason: "상위 패치가 없는 transitive advisory 3건",
    advisories: [
      { ghsa: "GHSA-2p57-rm9w-gvfp", module: "ip", severity: "high", versions: ["1.1.9"] },
      { ghsa: "GHSA-5p2g-fcmc-qvqq", module: "image-size", severity: "high", versions: ["0.6.3", "1.2.1"] },
      { ghsa: "GHSA-w3rx-r6r6-pgpr", module: "image-size", severity: "high", versions: ["0.6.3", "1.2.1"] },
    ],
    ...overrides,
  };
}

test("승인 목록에 있는 저장소는 서명 감사 예외를 가질 수 있다", () => {
  assert.equal(dependencyAuditExceptionSchema.safeParse(exception()).success, true);
  assert.equal(
    dependencyAuditExceptionSchema.safeParse(exception({
      repositoryId: "1250442131",
      fullName: "seorilabs/happy-farm",
    })).success,
    true,
  );
});

test("승인 목록 밖 저장소는 이름이 그럴듯해도 거부한다", () => {
  assert.equal(
    dependencyAuditExceptionSchema.safeParse(exception({
      repositoryId: "1265192029",
      fullName: "seorilabs/lizard-tycoon",
    })).success,
    false,
  );
});

test("승인된 id와 다른 저장소 이름을 짝지으면 거부한다", () => {
  const result = dependencyAuditExceptionSchema.safeParse(exception({ fullName: "seorilabs/happy-farm" }));
  assert.equal(result.success, false);
  assert.equal(
    result.success ? null : result.error.issues.some((issue) => issue.path.at(-1) === "fullName"),
    true,
  );
});

test("advisory 수는 중앙 검증기와 같은 범위를 허용하고 정렬과 중복을 강제한다", () => {
  const single = exception({
    advisories: [{ ghsa: "GHSA-2p57-rm9w-gvfp", module: "ip", severity: "high", versions: ["1.1.9"] }],
  });
  assert.equal(dependencyAuditExceptionSchema.safeParse(single).success, true);
  assert.equal(dependencyAuditExceptionSchema.safeParse(exception({ advisories: [] })).success, false);

  const duplicated = exception({
    advisories: [
      { ghsa: "GHSA-2p57-rm9w-gvfp", module: "ip", severity: "high", versions: ["1.1.9"] },
      { ghsa: "GHSA-2p57-rm9w-gvfp", module: "ip", severity: "high", versions: ["1.1.9"] },
    ],
  });
  assert.equal(dependencyAuditExceptionSchema.safeParse(duplicated).success, false);

  const unsorted = exception({
    advisories: [
      { ghsa: "GHSA-5p2g-fcmc-qvqq", module: "image-size", severity: "high", versions: ["0.6.3"] },
      { ghsa: "GHSA-2p57-rm9w-gvfp", module: "ip", severity: "high", versions: ["1.1.9"] },
    ],
  });
  assert.equal(dependencyAuditExceptionSchema.safeParse(unsorted).success, false);
});

test("중앙 검증기가 요구하는 두 actionClass binding을 그대로 요구한다", () => {
  const onlyStatic = exception({
    bindings: [{ actionClass: "STATIC_CHECK", sourceSha: SOURCE_SHA, lockfileSha256: LOCKFILE }],
  });
  assert.equal(dependencyAuditExceptionSchema.safeParse(onlyStatic).success, false);
});

test("STATIC_CHECK 후보 승인은 기존 base와 별도의 exact PR head, merge, lock을 보존한다", () => {
  const original = dependencyAuditExceptionSchema.parse(exception());
  const candidate = {
    number: 147,
    headSha: "a".repeat(40),
    mergeSha: "b".repeat(40),
    lockfileSha256: `sha256:${"c".repeat(64)}`,
  };
  original.bindings[0].pullRequestCandidate = candidate;
  const parsed = dependencyAuditExceptionSchema.parse(original);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.bindings[0].sourceSha, SOURCE_SHA);
  assert.equal(parsed.bindings[0].lockfileSha256, LOCKFILE);
  assert.deepEqual(parsed.bindings[0].pullRequestCandidate, candidate);
  assert.equal(parsed.expiresAt, exception().expiresAt);
  assert.deepEqual(parsed.advisories, exception().advisories);
});

test("PR 후보 승인은 누락, 다른 권한 필드와 Android binding에 들어가면 거부된다", () => {
  const candidate = {
    number: 147,
    headSha: "a".repeat(40),
    mergeSha: "b".repeat(40),
    lockfileSha256: `sha256:${"c".repeat(64)}`,
  };
  const missingMerge: Partial<typeof candidate> = { ...candidate };
  delete missingMerge.mergeSha;
  for (const invalid of [
    missingMerge,
    { ...candidate, number: 0 },
    { ...candidate, number: Number.MAX_SAFE_INTEGER + 1 },
    { ...candidate, headSha: "main" },
    { ...candidate, lockfileSha256: LOCKFILE.slice(7) },
    { ...candidate, expiresAt: "2030-01-01T00:00:00Z" },
    { ...candidate, advisories: [] },
  ]) {
    const value = dependencyAuditExceptionSchema.parse(exception());
    assert.equal(dependencyAuditExceptionSchema.safeParse({
      ...value,
      bindings: [{ ...value.bindings[0], pullRequestCandidate: invalid }, value.bindings[1]],
    }).success, false);
  }
  const value = dependencyAuditExceptionSchema.parse(exception());
  assert.equal(dependencyAuditExceptionSchema.safeParse({
    ...value,
    bindings: [value.bindings[0], { ...value.bindings[1], pullRequestCandidate: candidate }],
  }).success, false);
});

test("ConfigRevision은 감사 사유의 문자 치환 흔적을 저장 전에 거부한다", () => {
  for (const reason of [
    "상위 패치가 없는 \uFFFD advisory",
    "AppsInToss/Granite/Metro ???? transitive ip?image-size advisory 3?? ?? ?? ???",
    "AppsInToss/Granite transitive ??? 3?? ?? ??? ??",
    "??", "상위 패치 ?? 확인", "상위 패치가 ???.", "상위 패치가 ???, 재검토", "상위 패치(???)",
  ]) {
    const result = configRevisionPayloadSchema.safeParse({
      schemaVersion: 1, markets: [], build: { dependencyAuditException: exception({ reason }) },
    });
    assert.equal(result.success, false, reason);
    if (!result.success) assert.ok(result.error.issues.some(
      (issue) => issue.path.join(".") === "build.dependencyAuditException.reason",
    ));
  }
});

test("ConfigRevision은 물음표를 쓴 정상 한글 사유를 보존한다", () => {
  for (const reason of [
    "상위 패치가 공개됐나요? 공개 전까지 승인한 예외를 유지한다.",
    "패치 미공개? 다음 주에 재검토한다.",
    "정말 패치가 없나요?? 현재는 상위 패치를 기다린다.",
    "AppsInToss/Granite transitive 의존성 3건은 상위 패치가 없다.",
  ]) {
    const result = configRevisionPayloadSchema.parse({
      schemaVersion: 1, markets: [], build: { dependencyAuditException: exception({ reason }) },
    });
    assert.equal(result.build?.dependencyAuditException?.reason, reason);
  }
});
