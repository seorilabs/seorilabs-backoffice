import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIssueBody,
  extractTeammateMarkers,
  markerFindingKey,
  parsePatrolFindings,
  patrolDedupeKey,
  registrationDecision,
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
  assert.equal(patrolDedupeKey("noeul", new Date("2026-08-21T16:00:00Z")), "patrol:noeul:20260822");
  assert.equal(patrolDedupeKey("seori", new Date("2026-08-21T10:00:00Z")), "patrol:seori:20260821");
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
  const marker = teammateIssueMarker("baram", "dau-drop:foam-party");
  const closedIssueBody = `해결됨\n\n${marker}\n<!-- 다른 주석 -->`;
  assert.deepEqual(extractTeammateMarkers(closedIssueBody), ["baram:dau-drop:foam-party"]);
  assert.deepEqual(extractTeammateMarkers("marker 없는 본문"), []);
});

test("marker 의 팀원 접두를 벗기면 담당제 전환 전 이슈와도 dedupe 가 이어진다", () => {
  // 직군 체계(data)로 등록된 이슈의 marker 도 finding key 는 같다.
  assert.equal(markerFindingKey("data:dau-drop:foam-party"), "dau-drop:foam-party");
  assert.equal(markerFindingKey("baram:dau-drop:foam-party"), "dau-drop:foam-party");
  assert.equal(markerFindingKey("no-colon"), "no-colon");
});

test("발견 0건 순찰은 0건으로 보고한다", () => {
  const report = renderPatrolReport(TEAMMATES.noeul, [], "");
  assert.match(report, /노을 순찰 보고/);
  assert.match(report, /이상 없음 — 발견 0건/);
});

test("현황 스냅샷이 있는 팀원은 0건이어도 스냅샷과 함께 보고한다", () => {
  // 총괄 리포트는 경고가 없어도 월누적 수치가 본문이다.
  const report = renderPatrolReport(TEAMMATES.seori, [], "", [
    "이번 달(2026-08) 종량제 현황",
    "- GitHub Actions: 환산 1500분/3000분 (50%)",
  ]);
  assert.match(report, /서리 순찰 보고/);
  assert.match(report, /환산 1500분\/3000분/);
  assert.match(report, /경고 없음/);
  assert.ok(!report.includes("이상 없음 — 발견 0건"));
});

test("발견이 있으면 스냅샷 뒤에 경고 목록이 붙는다", () => {
  const report = renderPatrolReport(
    TEAMMATES.seori,
    [fixture({ key: "gh-overage:2026-08", title: "GitHub Actions 초과 과금", repoFullName: null })],
    "",
    ["- GitHub Actions: 환산 4000분/3000분 (133%)"],
  );
  assert.match(report, /환산 4000분\/3000분/);
  assert.match(report, /발견 1건/);
  assert.match(report, /GitHub Actions 초과 과금/);
});

test("순찰 보고는 발견·초안·중복 수와 근거를 담는다", () => {
  const findings = [
    fixture({ status: "drafted" }),
    fixture({ key: "x", title: "기존 건", status: "deduped", issueUrl: "https://github.com/seorilabs/foam-party/issues/1" }),
  ];
  const report = renderPatrolReport(TEAMMATES.noeul, findings, "요약 서술");
  assert.match(report, /발견 2건 · 자동 등록 0건 · 이슈 초안 1건 · 기존 이슈 중복 1건/);
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

test("등록 재클릭은 기존 이슈 URL 로 멱등 처리된다", () => {
  const decision = registrationDecision(
    fixture({ status: "registered", issueUrl: "https://github.com/seorilabs/foam-party/issues/9" }),
  );
  assert.deepEqual(decision, {
    action: "already",
    issueUrl: "https://github.com/seorilabs/foam-party/issues/9",
  });
});

test("drafted 초안만 등록 대상이 되고 근거 게이트를 다시 통과해야 한다", () => {
  assert.deepEqual(registrationDecision(fixture({ status: "drafted" })), {
    action: "register",
    repoFullName: "seorilabs/foam-party",
  });
  assert.throws(() => registrationDecision(fixture({ status: "skipped" })), /등록 대상 초안이 아닙니다/);
  assert.throws(() => registrationDecision(fixture({ status: "deduped" })), /등록 대상 초안이 아닙니다/);
  assert.throws(
    () => registrationDecision(fixture({ status: "drafted", evidence: [] })),
    /근거 없는 초안은 등록할 수 없습니다/,
  );
  assert.throws(
    () => registrationDecision(fixture({ status: "drafted", repoFullName: null })),
    /근거 없는 초안은 등록할 수 없습니다/,
  );
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

test("자동 등록은 P1·P2 이면서 초안 요건을 갖춘 항목만 상한 안에서 고른다", async () => {
  const { isAutoRegisterPriority, selectAutoRegisterIndexes } = await import(
    "@/lib/discord/teammate-findings"
  );
  assert.ok(isAutoRegisterPriority(["P1"]));
  assert.ok(isAutoRegisterPriority(["P2", "bug"]));
  assert.ok(!isAutoRegisterPriority(["P3"]));
  assert.ok(!isAutoRegisterPriority([]));

  const findings = [
    fixture({ key: "a", labels: ["P2"] }),
    fixture({ key: "b", labels: ["P3"] }), // 우선순위 미달 → confirm 카드
    fixture({ key: "c", labels: ["P1"], repoFullName: null }), // 대상 레포 없음
    fixture({ key: "d", labels: ["P2"], status: "deduped" }), // 기존 이슈
    fixture({ key: "e", labels: ["P1"] }),
    fixture({ key: "f", labels: ["P2"] }),
  ];
  // 상한 2 — a, e 까지만.
  assert.deepEqual(selectAutoRegisterIndexes(findings, 2), [0, 4]);
  assert.deepEqual(selectAutoRegisterIndexes(findings, 10), [0, 4, 5]);
});

test("채택률 게이트는 표본이 차기 전엔 열려 있고 NOT_PLANNED 비율 초과 시 닫힌다", async () => {
  const { evaluateAutoRegistration } = await import("@/lib/discord/teammate-findings");
  const opts = { minSample: 5, disablePct: 30 };
  // 표본 미달 — 초기엔 자동 등록 허용.
  assert.equal(evaluateAutoRegistration({ registered: 4, notPlanned: 4 }, opts).enabled, true);
  // 표본 충족 + 비율 미달 — 유지.
  assert.equal(evaluateAutoRegistration({ registered: 10, notPlanned: 2 }, opts).enabled, true);
  // 비율 초과 — 수동 복귀(사유 포함).
  const closed = evaluateAutoRegistration({ registered: 10, notPlanned: 3 }, opts);
  assert.equal(closed.enabled, false);
  assert.match(closed.reason ?? "", /30%/);
});

test("이슈 URL 파싱은 repo 와 번호를 복원한다", async () => {
  const { parseIssueUrl } = await import("@/lib/discord/teammate-findings");
  assert.deepEqual(parseIssueUrl("https://github.com/seorilabs/happy-farm/issues/482"), {
    repoFullName: "seorilabs/happy-farm",
    number: 482,
  });
  assert.equal(parseIssueUrl("https://github.com/seorilabs/happy-farm/pull/1"), null);
  assert.equal(parseIssueUrl("not-a-url"), null);
});

test("초안 만료는 3일이 지난 run 의 drafted 만 고른다", async () => {
  const { selectExpiredDraftIndexes } = await import("@/lib/discord/teammate-findings");
  const findings = [
    fixture({ key: "a", status: "drafted" }),
    fixture({ key: "b", status: "registered" }),
    fixture({ key: "c", status: "drafted" }),
  ];
  const created = new Date("2026-08-20T00:00:00Z");
  // 3일 미만 — 만료 없음.
  assert.deepEqual(selectExpiredDraftIndexes(findings, created, new Date("2026-08-22T00:00:00Z")), []);
  // 3일 경과 — drafted 만.
  assert.deepEqual(selectExpiredDraftIndexes(findings, created, new Date("2026-08-23T00:00:01Z")), [0, 2]);
});
