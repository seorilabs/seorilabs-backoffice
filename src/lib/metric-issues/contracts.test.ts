import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateGate, registrationSlot, renderMetricIssue, verifyCodeProof, type Candidate, type MetricFact } from "./contracts";
const fact: MetricFact = { metric: "ga4_dau", day: "2026-10-15", periodStart: "2026-10-08", baseline: 100, latest: 40, baselineDays: 7, sample: 40, complete: true, mature: true, source: "ga4", scope: "app:one", runId: "run", direction: "lowlight" };
const candidate: Candidate = { title: "첫 행동을 집계할 수 있도록 이벤트 계약을 맞춘다", kind: "instrumentation", priority: "P3", problemKey: "missing-action-parameter", customerProblem: "핵심 행동이 기록되지 않아 초기 경험의 문제를 확인할 수 없습니다.", outcome: "선언된 이벤트 계약을 충족합니다.", scope: ["src/events.ts"], acceptanceCriteria: ["실제 전송 경로가 이벤트 계약을 충족한다", "중복 전송 없이 저장한다"], validation: ["해당 이벤트 경로의 개발 환경 회귀"], proof: { path: "src/events.ts", line: 1, excerpt: 'send("action", {})', contractPath: "src/spec.ts", contractExcerpt: 'required: ["action_id"]', expected: "action_id를 전달한다", actual: "해당 전송 경로에 action_id가 없다", reproduction: "핵심 행동 처리 경로를 실행하고 event parameter를 확인한다" } };
test("등록 주기는 중앙 시간표를 재사용하고 같은 달력 슬롯을 반환한다", () => {
  assert.equal(registrationSlot(new Date("2026-10-18T05:01:00Z"), ["02:00", "14:00"]).toISOString(), "2026-10-18T05:00:00.000Z");
  assert.equal(registrationSlot(new Date("2026-10-17T15:30:00Z"), ["02:00", "14:00"]).toISOString(), "2026-10-17T05:00:00.000Z");
});
test("정책 제외·작은 표본·불완전·미성숙·최근 수정·금액 단독 후보를 차단한다", () => {
  const input = { enabled: true, open: 0, limit: 10, relatedFixAt: null, now: new Date("2026-10-18T05:00:00Z"), fact, kind: candidate.kind };
  assert.equal(candidateGate(input), "eligible");
  assert.equal(candidateGate({ ...input, enabled: false }), "excluded");
  assert.equal(candidateGate({ ...input, open: 10 }), "backpressure");
  assert.equal(candidateGate({ ...input, fact: { ...fact, complete: false } }), "insufficient");
  assert.equal(candidateGate({ ...input, fact: { ...fact, baselineDays: 3 } }), "insufficient");
  assert.equal(candidateGate({ ...input, fact: { ...fact, metric: "purchase_sales" } }), "insufficient");
  assert.equal(candidateGate({ ...input, fact: { ...fact, mature: false } }), "observing");
  assert.equal(candidateGate({ ...input, relatedFixAt: new Date("2026-10-17T00:00:00Z") }), "observing");
});
test("서버가 exact SHA 파일과 줄·선언 계약을 다시 읽어 확인한다", () => {
  const files = { "src/events.ts": 'send("action", {})\n', "src/spec.ts": 'required: ["action_id"]\n' };
  assert.equal(verifyCodeProof(candidate, files), true);
  assert.equal(verifyCodeProof(candidate, { ...files, "src/events.ts": 'send("action", { action_id: id })' }), false);
});
test("공개 이슈에는 원천 운영 수치를 넣지 않고 중앙 필수 절·멱등 마커를 유지한다", () => {
  const body = renderMetricIssue(candidate, fact, { repo: "seorilabs/example", sha: "a".repeat(40), marker: "metric-issue:test", publicRepository: true });
  assert.ok(body.includes("고객 가치")); assert.ok(body.includes("인수조건")); assert.ok(body.includes("metric-issue:test"));
  assert.ok(!body.includes("100")); assert.ok(!body.includes("최신 40"));
});
