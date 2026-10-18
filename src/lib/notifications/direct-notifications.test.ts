import assert from "node:assert/strict";
import test from "node:test";
import { reportDecision, signalDecision } from "./report-policy";
import { operationalEventLine, parseOperationalEvent } from "@/lib/platform/operational-events";

const account = {
  version: 1 as const, eventId: "identity_format_123456", type: "identity.created" as const,
  appId: "demo", outcome: "created", occurredAt: "2026-10-19T01:05:00Z",
  attributes: { authType: "firebase", appVersion: "1.8.4", runtime: "godot-native-android", platformUserId: "pu_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
};
test("리뷰 건별 발송은 묶음 제외 규칙을 적용하지 않는다", () => {
  const event = { kind: "STORE_REVIEW", payload: { externalReviewId: "review_a", rating: 5, change: "new", report: { category: "change", reason: "INDIVIDUAL_REVIEW" } } };
  assert.equal(reportDecision(event).send, true);
  assert.equal(reportDecision(event, true).send, false);
  assert.equal(signalDecision("review-themes").send, false);
});
test("새 계정은 앱과 버전을 묶고 승인된 운영 UID를 표시한다", () => {
  assert.ok(parseOperationalEvent(account));
  const line = operationalEventLine(account, "도마뱀 테라리움", new Date(account.occurredAt));
  assert.match(line, /\[도마뱀 테라리움:1\.8\.4\]/);
  assert.match(line, /신규계정/);
  assert.match(line, /UID: `pu_01ARZ3NDEKTSV4RRFFQ69G5FAV`/);
});

test("운영 UID 허용은 신규 계정으로 한정하고 로그인 UID와 표시 주입은 거부한다", () => {
  for (const platformUserId of ["person@example.com","pu_bad","pu_01ARZ3NDEKTSV4RRFFQ69G5FAI",123])
    assert.equal(parseOperationalEvent({...account,attributes:{...account.attributes,platformUserId}}),null);
  for (const key of ["uid","appUserId","email"])
    assert.equal(parseOperationalEvent({...account,attributes:{...account.attributes,[key]:"blocked"}}),null);
  assert.equal(parseOperationalEvent({...account,type:"iap.granted",attributes:{platformUserId:account.attributes.platformUserId}}),null);
  const line=operationalEventLine({...account,attributes:{authType:"firebase",appVersion:"@everyone\n**bad**"}},"앱",new Date(account.occurredAt),1);
  assert.doesNotMatch(line,/@everyone|\n/);
  assert.match(line,/신규계정#1 -/);
});
