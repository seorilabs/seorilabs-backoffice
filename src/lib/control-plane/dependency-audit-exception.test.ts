import assert from "node:assert/strict";
import test from "node:test";

import { dependencyAuditExceptionSchema } from "@/lib/control-plane/contracts";

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
