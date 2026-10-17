import { test } from "node:test";
import assert from "node:assert/strict";
import { reportDecision, signalDecision } from "./report-policy";

test("평점 작은 모수·수집 상태·출시 후 단순 관측은 내부 기록", () => {
  for (const kind of [
    "review-rating-change",
    "source-stale",
    "source-recovery",
    "release-impact",
    "keyword-change",
    "review-change",
    "service-failure",
    "submission-approved",
  ])
    assert.equal(signalDecision(kind).send, false, kind);
});
test("전송 대기 중인 구형 잡음도 제외하고 실제 피해·승인·요청은 보존", () => {
  for (const dedupeKey of [
    "console-collection:run1",
    "platform-approval-alert:scan:hour",
    "metrics:operations:2026-10-17",
    "metrics:daily:2026-10-16",
    "iap-row:x",
    "iap-daily:iap:a:day",
    "identity-row:x",
    "identity-daily:a:day",
    "stage-nudge:a:QA:day",
  ])
    assert.equal(
      reportDecision({
        kind: "OPERATIONAL_EVENT",
        dedupeKey,
        payload: { text: "old" },
      }).send,
      false,
      dedupeKey,
    );
  for (const input of [
    { kind: "INCIDENT", payload: { incidentId: "x" } },
    { kind: "OPS_ALERT", payload: { deploymentApprovalId: "x" } },
    { kind: "DEPLOY_COMPLETION", payload: { releaseRecordId: "x" } },
  ])
    assert.equal(reportDecision(input).send, true);
});
test("보고 중지는 실제 피해와 승인 응답을 유지", () => {
  assert.equal(
    reportDecision({ kind: "INCIDENT", payload: {} }, true).send,
    true,
  );
  assert.equal(
    reportDecision(
      { kind: "OPS_ALERT", payload: { deploymentApprovalId: "x" } },
      true,
    ).send,
    true,
  );
  assert.equal(
    reportDecision(
      {
        kind: "OPS_ALERT",
        payload: { report: { category: "change", reason: "유의한 변화" } },
      },
      true,
    ).send,
    false,
  );
});
test("확실한 결론이 없으면 분석 문장을 채우지 않음", () => {
  assert.equal(
    reportDecision({
      kind: "OPS_ALERT",
      payload: { report: { category: "internal", reason: "비교 표본 부족" } },
    }).send,
    false,
  );
  assert.equal(signalDecision("metric-change").send, true);
  assert.equal(signalDecision("support-failure").send, true);
});

test("개발 승인 버튼은 보고 중지 중에도 응답 가능해야 한다", () => {
  assert.equal(
    reportDecision(
      {
        kind: "OPS_ALERT",
        payload: {
          components: [
            { components: [{ custom_id: "approval:planning:issue1" }] },
          ],
        },
      },
      true,
    ).send,
    true,
  );
});

test("외부 요청 응답의 문장만으로 보고를 제외하지 않는다", () => {
  assert.equal(
    reportDecision({
      kind: "EXTERNAL_FEED",
      payload: { source: "review-bot", text: "리뷰 완료 · 요청한 수정 결과" },
    }).send,
    true,
  );
});
test("같은 결론의 지문은 전송 시각을 제외하고 thread·그림·상자 변경을 구분한다", async () => {
  const { reportFingerprint } = await import("./report-policy");
  const fp = (payload: unknown) => reportFingerprint("OPS_ALERT", payload);
  assert.equal(
    fp({ text: "a", embed: { color: 1, timestamp: "old" } }),
    fp({ text: "a", embed: { color: 1, timestamp: "new" } }),
  );
  assert.notEqual(
    fp({ text: "a", thread: { parentDedupeKey: "x" } }),
    fp({ text: "a", thread: { parentDedupeKey: "y" } }),
  );
  assert.notEqual(
    fp({ text: "a", embed: { color: 1 } }),
    fp({ text: "a", embed: { color: 2 } }),
  );
});

test("확인된 외부 리뷰 봇 자동 감사만 내부로 돌리고 승인·명시 응답·다른 생산자는 유지", () => {
  const decide = (payload: unknown) =>
    reportDecision({ kind: "EXTERNAL_FEED", payload }).send;
  assert.equal(
    decide({
      source: "seori-pr-bot",
      text: "🔎 **Seori PR 리뷰 로그**\nPR #47",
    }),
    false,
  );
  assert.equal(
    decide({ source: "seori-pr-bot", text: "⚠️ **Seori AI 쿼타 요약**" }),
    false,
  );
  assert.equal(
    decide({
      source: "seori-pr-bot",
      text: "원문",
      thread: { parentDedupeKey: "x" },
    }),
    false,
  );
  assert.equal(
    decide({ source: "seori-pr-bot", text: "✅ **Seori PR 승인**" }),
    true,
  );
  assert.equal(
    decide({
      source: "seori-pr-bot",
      text: "원문",
      thread: { parentDedupeKey: "x" },
      report: { category: "response" },
    }),
    true,
  );
  assert.equal(
    decide({ source: "different-producer", text: "🔎 **Seori PR 리뷰 로그**" }),
    true,
  );
});

test("과거 개별 리뷰 대기는 묶음으로 전환하되 같은 종류의 심사 전환과 요청 결과는 유지", () => {
  assert.equal(
    reportDecision({
      kind: "STORE_REVIEW",
      payload: { externalReviewId: "review-id", rating: 2, change: "new" },
    }).send,
    false,
  );
  assert.equal(
    reportDecision({
      kind: "STORE_REVIEW",
      payload: { state: "APPROVED", store: "APP_STORE" },
    }).send,
    true,
  );
  assert.equal(
    reportDecision({
      kind: "STORE_REVIEW",
      payload: { rating: 2, change: "new", report: { category: "response" } },
    }).send,
    true,
  );
});
