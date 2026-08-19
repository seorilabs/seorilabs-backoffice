import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeployAllStatusCardText,
  buildDeployStatusCardText,
} from "@/lib/notifications/deploy-format";

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

test("Play 승격 카드는 승격 게이트를 실행됨으로 표시한다", () => {
  const promoted = buildDeployStatusCardText({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.7",
    market: "PLAY",
    status: "SUCCEEDED",
    track: "production",
    workflowName: "Promote Google Play",
    updatedAt: AT,
  });
  // 승격 실행이 만든 카드에 "미실행" 이 남아 있으면 카드가 스스로를 부정한다.
  assert.match(promoted, /프로덕션 승격·심사: 🟢 실행됨/);
  assert.doesNotMatch(promoted, /프로덕션 승격·심사: ⚪ 미실행/);
});

test("승격 실행이 실패하면 게이트를 실행됨으로 표시하지 않는다", () => {
  const failed = buildDeployStatusCardText({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.7",
    market: "PLAY",
    status: "FAILED",
    track: "production",
    updatedAt: AT,
  });
  assert.match(failed, /프로덕션 승격·심사: ❌ 실패/);
});

test("내부 업로드 카드와 다른 마켓 카드는 게이트 표시가 그대로다", () => {
  const upload = buildDeployStatusCardText({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.7",
    market: "PLAY",
    status: "SUCCEEDED",
    track: null,
    updatedAt: AT,
  });
  assert.match(upload, /프로덕션 승격·심사: ⚪ 미실행/);
  const ait = buildDeployStatusCardText({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.7",
    market: "AIT",
    status: "SUCCEEDED",
    track: "production",
    updatedAt: AT,
  });
  assert.match(ait, /검수 제출: ⚪ 미실행/);
});
