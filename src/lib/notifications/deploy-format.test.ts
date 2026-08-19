import assert from "node:assert/strict";
import test from "node:test";
import { buildDeployAllStatusCardText } from "@/lib/notifications/deploy-format";

const AT = new Date("2026-08-18T23:38:00.000Z");

test("deploy-all 실패 카드는 마켓 업로드 미진행을 명시한다", () => {
  const text = buildDeployAllStatusCardText({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.6",
    status: "FAILED",
    runUrl: "https://github.com/seorilabs/lizard-tycoon/actions/runs/32197982643",
    updatedAt: AT,
  });
  assert.match(text, /내 도마뱀 키우기 v1\.1\.6 · 전체 마켓 배포/);
  assert.match(text, /배포 워크플로: ❌ 실패/);
  assert.match(text, /마켓 업로드가 진행되지 않았을 수 있다/);
  assert.match(text, /actions\/runs\/32197982643/);
});

test("deploy-all 성공 카드는 마켓 게이트를 단정하지 않는다", () => {
  const text = buildDeployAllStatusCardText({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.6",
    status: "SUCCEEDED",
    updatedAt: AT,
  });
  assert.match(text, /배포 워크플로: ✅ 업로드 경로 성공/);
  assert.doesNotMatch(text, /공개 배포/);
});
