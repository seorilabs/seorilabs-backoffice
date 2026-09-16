import assert from "node:assert/strict";
import test from "node:test";
import { EMBED_COLOR } from "@/lib/notifications/style";
import {
  renderDeployAllStatusCard,
  renderDeployStatusCard,
} from "@/lib/notifications/deploy-format";

const AT = new Date("2026-08-18T23:38:00.000Z");

test("deploy-all 실패 카드는 마켓 업로드 미진행을 명시한다", () => {
  const card = renderDeployAllStatusCard({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.6",
    status: "FAILED",
    runUrl: "https://github.com/seorilabs/lizard-tycoon/actions/runs/32197982643",
    updatedAt: AT,
  });
  // 앱·버전·마켓은 제목으로 올려 카드가 스크롤에서 앵커가 되게 한다.
  assert.equal(card.embed?.title, "🚀 내 도마뱀 키우기 v1.1.6 · 전체 마켓 배포");
  assert.equal(card.embed?.color, EMBED_COLOR.FAILURE);
  assert.equal(card.embed?.url, "https://github.com/seorilabs/lizard-tycoon/actions/runs/32197982643");
  // 갱신 시각은 본문이 아니라 상자 하단에 Discord 가 렌더한다.
  assert.equal(card.embed?.timestamp, AT.toISOString());
  assert.doesNotMatch(card.text, /마지막 갱신/);
  assert.match(card.text, /배포 워크플로: ❌ 실패/);
  assert.match(card.text, /마켓 업로드가 진행되지 않았을 수 있다/);
  assert.match(card.text, /actions\/runs\/32197982643/);
});

test("deploy-all 성공 카드는 마켓 게이트를 단정하지 않는다", () => {
  const text = renderDeployAllStatusCard({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.6",
    status: "SUCCEEDED",
    updatedAt: AT,
  }).text;
  assert.match(text, /배포 워크플로: ✅ 업로드 경로 성공/);
  assert.doesNotMatch(text, /공개 배포/);
});

test("Play 승격 카드는 승격 게이트를 실행됨으로 표시한다", () => {
  const promoted = renderDeployStatusCard({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.7",
    market: "PLAY",
    status: "SUCCEEDED",
    track: "production",
    workflowName: "Promote Google Play",
    updatedAt: AT,
  }).text;
  // 승격 실행이 만든 카드에 "미실행" 이 남아 있으면 카드가 스스로를 부정한다.
  assert.match(promoted, /프로덕션 승격·심사: 🟢 실행됨/);
  assert.doesNotMatch(promoted, /프로덕션 승격·심사: ⚪ 미실행/);
});

test("승격 실행이 실패하면 게이트를 실행됨으로 표시하지 않는다", () => {
  const failed = renderDeployStatusCard({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.7",
    market: "PLAY",
    status: "FAILED",
    track: "production",
    updatedAt: AT,
  }).text;
  assert.match(failed, /프로덕션 승격·심사: ❌ 실패/);
});

test("내부 업로드 카드와 다른 마켓 카드는 게이트 표시가 그대로다", () => {
  const upload = renderDeployStatusCard({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.7",
    market: "PLAY",
    status: "SUCCEEDED",
    track: null,
    updatedAt: AT,
  }).text;
  assert.match(upload, /프로덕션 승격·심사: ⚪ 미실행/);
  const ait = renderDeployStatusCard({
    displayName: "내 도마뱀 키우기",
    version: "v1.1.7",
    market: "AIT",
    status: "SUCCEEDED",
    track: "production",
    updatedAt: AT,
  }).text;
  assert.match(ait, /검수 제출: ⚪ 미실행/);
});
