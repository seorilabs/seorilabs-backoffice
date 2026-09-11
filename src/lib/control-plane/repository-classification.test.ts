import assert from "node:assert/strict";
import test from "node:test";

import { repositoryClassificationPolicy } from "@/lib/control-plane/repository-classification";

test("앱이 아닌 저장소는 중앙 정책에서 EXCLUDED로 판정된다", () => {
  // 분류 결정(DB)만 EXCLUDED로 기록하면 discovery가 중앙 정책을 보고 여전히 후보로 판단해
  // App row를 다시 만든다. 그 row는 비-PRODUCT_APP 저장소에서 readiness를 막으므로,
  // 실제로 삭제해도 다음 discovery에서 되살아난다. 중앙 정책이 정본이어야 한다.
  for (const fullName of [
    "seorilabs/seoritales",
    "seorilabs/planning",
    "seorilabs/credentials",
  ]) {
    const policy = repositoryClassificationPolicy(fullName);
    assert.ok(policy, `${fullName} 정책이 없다`);
    assert.ok(
      policy.classification === "EXCLUDED" || policy.classification === "INFRA_REPO",
      `${fullName}이 제품 앱으로 판정된다`,
    );
    assert.equal(policy.allowPublicDiscovery, false);
  }
});

test("대소문자가 달라도 같은 정책을 돌려준다", () => {
  assert.deepEqual(
    repositoryClassificationPolicy("seorilabs/Seoritales"),
    repositoryClassificationPolicy("seorilabs/seoritales"),
  );
});

test("정책에 없는 저장소는 null을 돌려준다", () => {
  // 신규 저장소를 앱이라고 추측해 자동 편입하지 않는다. 판정은 사람이 기록한다.
  assert.equal(repositoryClassificationPolicy("seorilabs/does-not-exist-xyz"), null);
});
