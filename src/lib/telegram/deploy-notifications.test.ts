import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeployCompletionText,
  buildDeployStatusCardText,
  deployCompletionPayload,
  deployNotificationDedupeKey,
  nextNotificationAttemptAt,
} from "@/lib/telegram/deploy-notification-format";
import { telegramContextFromAuditPayload } from "@/lib/telegram/release-message-payload";

test("배포 완료 알림에 한글 앱명·버전·마켓·실행 링크를 모두 표시한다", () => {
  const text = buildDeployCompletionText({
    displayName: "루시드 체스",
    version: "v1.1.12",
    market: "AIT",
    status: "SUCCEEDED",
    workflowName: "Deploy to AIT",
    runUrl: "https://github.com/seorilabs/lucid-chess/actions/runs/123",
  });
  assert.match(text, /✅ <b>배포 완료<\/b>/);
  assert.match(text, /앱: <b>루시드 체스<\/b>/);
  assert.match(text, /버전: <code>v1\.1\.12<\/code>/);
  assert.match(text, /마켓: AppsInToss/);
  assert.match(text, /actions\/runs\/123/);
});

test("실패와 Xcode Cloud 빌드 번호도 완료 메시지에서 구분한다", () => {
  const text = buildDeployCompletionText({
    displayName: "함께봄",
    version: "v0.0.1",
    market: "APPSTORE",
    status: "FAILED",
    workflowName: "Xcode Cloud",
    externalBuildNumber: 42,
  });
  assert.match(text, /❌ <b>배포 실패<\/b>/);
  assert.match(text, /마켓: App Store/);
  assert.match(text, /Xcode Cloud 빌드: #42/);
});

test("Discord 릴리즈 카드는 워크플로와 후속 마켓 gate를 분리한다", () => {
  const text = buildDeployStatusCardText({
    displayName: "해피팜",
    version: "v1.6.0",
    market: "PLAY",
    status: "SUCCEEDED",
    workflowName: "Deploy Google Play",
    runUrl: "https://github.com/seorilabs/happy-farm/actions/runs/123",
    updatedAt: new Date("2026-08-17T13:00:00Z"),
  });
  assert.match(text, /업로드 경로 성공/);
  assert.match(text, /Play 처리: ⚪ 미확인/);
  assert.match(text, /내부 테스터 설치 QA: ⚪ 미확인/);
  assert.match(text, /공개 배포: ⚪ 미실행/);
  assert.match(text, /actions\/runs\/123/);
  assert.doesNotMatch(text, /공개 완료/);
});

test("outbox payload와 원문 Telegram 좌표는 유효한 값만 복원한다", () => {
  assert.deepEqual(
    deployCompletionPayload({
      releaseRecordId: "cm12345678901234567890123",
      status: "SUCCEEDED",
      runUrl: "https://example.com/run/1",
    }),
    {
      releaseRecordId: "cm12345678901234567890123",
      status: "SUCCEEDED",
      runUrl: "https://example.com/run/1",
    },
  );
  assert.equal(deployCompletionPayload({ releaseRecordId: "../bad" }), null);
  assert.deepEqual(
    deployCompletionPayload({
      releaseRecordId: "cm12345678901234567890123",
      status: "IN_PROGRESS",
    }),
    {
      releaseRecordId: "cm12345678901234567890123",
      status: "IN_PROGRESS",
      runUrl: undefined,
    },
  );
  assert.equal(
    deployCompletionPayload({
      releaseRecordId: "cm12345678901234567890123",
      status: "UNKNOWN",
    }),
    null,
  );
  assert.deepEqual(
    telegramContextFromAuditPayload({
      telegram: { chatId: "-100123", messageId: 77 },
    }),
    { chatId: "-100123", messageId: 77 },
  );
  assert.equal(
    telegramContextFromAuditPayload({ telegram: { chatId: "x", messageId: 77 } }),
    null,
  );
});

test("완료 알림은 GitHub 실행 차수별 event key로 멱등 처리한다", () => {
  const releaseId = "cm12345678901234567890123";
  assert.equal(
    deployNotificationDedupeKey(releaseId, "github:123:2"),
    `deploy:${releaseId}:github:123:2`,
  );
  assert.throws(() => deployNotificationDedupeKey(releaseId, "../bad"));
});

test("전송 실패 재시도는 30초 지수 backoff와 30분 상한을 사용한다", () => {
  const now = new Date("2026-07-24T00:00:00Z");
  assert.equal(
    nextNotificationAttemptAt(0, now).toISOString(),
    "2026-07-24T00:00:30.000Z",
  );
  assert.equal(
    nextNotificationAttemptAt(20, now).toISOString(),
    "2026-07-24T00:30:00.000Z",
  );
});
