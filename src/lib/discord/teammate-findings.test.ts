import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIssueBody,
  extractTeammateMarkers,
  parsePatrolFindings,
  patrolDedupeKey,
  renderPatrolReport,
  selectDraftIndexes,
  teammateIssueMarker,
  type PatrolFinding,
} from "@/lib/discord/teammate-findings";
import { TEAMMATES } from "@/lib/discord/teammates";

function fixture(overrides: Partial<PatrolFinding>): PatrolFinding {
  return {
    key: "dau-drop:foam-party",
    title: "폼파티 DAU 급락",
    detail: "폼파티 DAU 가 중앙값 절반 아래다.",
    repoFullName: "seorilabs/foam-party",
    labels: ["P2"],
    evidence: ["2026-08-20 DAU 12", "직전 7일 중앙값 30"],
    status: "skipped",
    ...overrides,
  };
}

test("순찰 dedupe 키는 KST 날짜 기준이라 하루 1회를 보장한다", () => {
  // 16:00Z 는 KST 로 다음날 01:00 — UTC 날짜로 만들면 CronJob 재발화가 이중 실행된다.
  assert.equal(patrolDedupeKey("data", new Date("2026-08-21T16:00:00Z")), "patrol:data:20260822");
  assert.equal(patrolDedupeKey("qa", new Date("2026-08-21T10:00:00Z")), "patrol:qa:20260821");
});

test("근거 없는 항목과 대상 레포 없는 항목은 초안이 되지 않는다", () => {
  const findings = [
    fixture({ key: "a", evidence: [] }),
    fixture({ key: "b", repoFullName: null }),
    fixture({ key: "c" }),
  ];
  assert.deepEqual(selectDraftIndexes(findings), [2]);
});

test("초안은 실행당 3건으로 상한하고 dedupe 된 항목은 제외한다", () => {
  const findings = [
    fixture({ key: "a" }),
    fixture({ key: "b", status: "deduped" }),
    fixture({ key: "c" }),
    fixture({ key: "d" }),
    fixture({ key: "e" }),
  ];
  assert.deepEqual(selectDraftIndexes(findings), [0, 2, 3]);
});

test("이슈 marker 는 본문에서 그대로 복원돼 open+closed dedupe 에 쓰인다", () => {
  const marker = teammateIssueMarker("data", "dau-drop:foam-party");
  const closedIssueBody = `해결됨\n\n${marker}\n<!-- 다른 주석 -->`;
  assert.deepEqual(extractTeammateMarkers(closedIssueBody), ["data:dau-drop:foam-party"]);
  assert.deepEqual(extractTeammateMarkers("marker 없는 본문"), []);
});

test("발견 0건 순찰은 0건으로 보고한다", () => {
  const report = renderPatrolReport(TEAMMATES.data, [], "");
  assert.match(report, /서리 데이터 순찰 보고/);
  assert.match(report, /이상 없음 — 발견 0건/);
});

test("순찰 보고는 발견·초안·중복 수와 근거를 담는다", () => {
  const findings = [
    fixture({ status: "drafted" }),
    fixture({ key: "x", title: "기존 건", status: "deduped", issueUrl: "https://github.com/seorilabs/foam-party/issues/1" }),
  ];
  const report = renderPatrolReport(TEAMMATES.data, findings, "요약 서술");
  assert.match(report, /발견 2건 · 이슈 초안 1건 · 기존 이슈 중복 1건/);
  assert.match(report, /요약 서술/);
  assert.match(report, /직전 7일 중앙값 30/);
  assert.match(report, /기존 이슈: https:\/\/github\.com\/seorilabs\/foam-party\/issues\/1/);
});

test("이슈 본문에는 근거 목록과 dedupe marker 가 반드시 들어간다", () => {
  const body = buildIssueBody("data", fixture({ suggestion: "계측을 먼저 확인" }));
  assert.match(body, /## 근거/);
  assert.match(body, /2026-08-20 DAU 12/);
  assert.match(body, /## 제안/);
  assert.ok(body.includes(teammateIssueMarker("data", "dau-drop:foam-party")));
});

test("findings JSON 파싱은 손상된 항목을 거르고 상태를 보수적으로 되돌린다", () => {
  const parsed = parsePatrolFindings([
    { key: "a", title: "t", detail: "d", repoFullName: "o/r", labels: ["P2"], evidence: ["e"], status: "registered", issueUrl: "u" },
    { key: "b", title: "t2", status: "이상한값" },
    { title: "key 없음" },
    "문자열",
    null,
  ] as never);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].status, "registered");
  assert.equal(parsed[0].issueUrl, "u");
  assert.equal(parsed[1].status, "skipped");
  assert.deepEqual(parsed[1].evidence, []);
});
