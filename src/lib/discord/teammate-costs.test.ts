import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGcpMonthCostSql,
  financeMonth,
  gcpBudgetFindings,
  githubQuotaMultiplier,
  githubUsageFindings,
  llmBudgetFindings,
  parseBillingTable,
  renderGcpCostLines,
  stabilityFindings,
  summarizeGithubUsage,
  type GithubUsageItem,
} from "@/lib/discord/teammate-costs";

test("hosted 분량 환산 배수는 macOS 10x·Windows 2x·Linux 1x, 저장소는 0", () => {
  assert.equal(githubQuotaMultiplier("Actions Linux"), 1);
  assert.equal(githubQuotaMultiplier("Actions macOS 3-core"), 10);
  assert.equal(githubQuotaMultiplier("Actions Windows"), 2);
  assert.equal(githubQuotaMultiplier("Actions storage"), 0);
  assert.equal(githubQuotaMultiplier("Packages data transfer"), 0);
});

const AUGUST_ITEMS: GithubUsageItem[] = [
  { date: "2026-08-01T00:00:00Z", sku: "Actions Linux", quantity: 2900, grossAmount: 17.4, netAmount: 2.844, repositoryName: "lizard-tycoon" },
  { date: "2026-08-01T00:00:00Z", sku: "Actions macOS 3-core", quantity: 108, grossAmount: 6.68, netAmount: 2.156, repositoryName: "lizard-tycoon" },
  { date: "2026-08-01T00:00:00Z", sku: "Actions storage", quantity: 906, grossAmount: 0.3, netAmount: 0.305, repositoryName: "spiritgate-defenders" },
  { date: "2026-07-01T00:00:00Z", sku: "Actions Linux", quantity: 812, grossAmount: 4.87, netAmount: 0, repositoryName: "periodic-table-app" },
];

test("월 사용량 요약은 해당 월만 집계하고 저장소를 분량에서 제외한다", () => {
  const summary = summarizeGithubUsage(AUGUST_ITEMS, "2026-08");
  assert.equal(summary.quotaMinutes, 2900 + 108 * 10); // storage 제외
  assert.equal(summary.netUsd, 5.305); // storage 초과분도 실청구에는 포함
  assert.equal(summary.topRepos[0].repo, "lizard-tycoon");
});

test("실청구가 시작되면 임계와 무관하게 초과 경고를 만든다", () => {
  const summary = summarizeGithubUsage(AUGUST_ITEMS, "2026-08");
  const findings = githubUsageFindings(summary, 3_000);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /초과 과금 \$5\.31/);
  assert.ok(findings[0].evidence.some((line) => line.includes("3980분")));
  assert.equal(findings[0].repoFullName, null); // 비용 경고는 이슈 초안 대상이 아님
});

test("실청구 전에는 70%·90% 임계로만 경고한다", () => {
  const at50 = summarizeGithubUsage([{ date: "2026-08-01", sku: "Actions Linux", quantity: 1_500, grossAmount: 9, netAmount: 0 }], "2026-08");
  assert.deepEqual(githubUsageFindings(at50, 3_000), []);
  const at75 = summarizeGithubUsage([{ date: "2026-08-01", sku: "Actions Linux", quantity: 2_250, grossAmount: 13.5, netAmount: 0 }], "2026-08");
  assert.match(githubUsageFindings(at75, 3_000)[0].title, /75% 소진/);
  const at95 = summarizeGithubUsage([{ date: "2026-08-01", sku: "Actions Linux", quantity: 2_850, grossAmount: 17.1, netAmount: 0 }], "2026-08");
  assert.match(githubUsageFindings(at95, 3_000)[0].title, /초과 임박/);
});

test("billing export 테이블 경로는 project.dataset.table 3분절만 허용한다", () => {
  assert.deepEqual(parseBillingTable("seorilabs-ci.billing_export.gcp_billing_export_v1_XXXX"), {
    project: "seorilabs-ci",
    dataset: "billing_export",
    table: "gcp_billing_export_v1_XXXX",
  });
  assert.equal(parseBillingTable("only.two"), null);
  assert.equal(parseBillingTable(""), null);
  assert.equal(parseBillingTable("a..b"), null);
});

test("GCP 월비용 SQL 은 invoice.month 로 자르고 credits 를 순비용에 반영한다", () => {
  const sql = buildGcpMonthCostSql("p.d.t", "202608");
  assert.match(sql, /invoice\.month = '202608'/);
  assert.match(sql, /UNNEST\(credits\)/);
  assert.match(sql, /GROUP BY project_id, currency/);
});

test("GCP 비용 렌더는 총액과 상위 프로젝트를 요약한다", () => {
  const rendered = renderGcpCostLines([
    { project_id: "crossword-puzzle-79ae0", currency: "KRW", net_cost: 3200.5 },
    { project_id: "seorilabs-ci", currency: "KRW", net_cost: 1100 },
    { project_id: "tiny", currency: "KRW", net_cost: 0.2 },
  ]);
  assert.equal(rendered.total, 4300.7);
  assert.match(rendered.lines[0], /₩4,301/);
  assert.match(rendered.lines[1], /crossword-puzzle-79ae0/);
  assert.equal(rendered.lines.length, 3); // 1원 미만 프로젝트는 생략
});

test("GCP 예산 경고는 예산이 확정된 뒤에만 발동한다", () => {
  assert.deepEqual(gcpBudgetFindings(50_000, 0, "202608"), []); // 예산 미확정 → 보고만
  assert.deepEqual(gcpBudgetFindings(5_000, 10_000, "202608"), []); // 50%
  assert.match(gcpBudgetFindings(8_000, 10_000, "202608")[0].title, /80% 도달/);
  assert.match(gcpBudgetFindings(12_000, 10_000, "202608")[0].title, /예산 초과/);
});

test("LLM 예산 경고는 GCP 예산과 같은 70%/100% 규칙을 따른다", () => {
  assert.deepEqual(llmBudgetFindings(3, 0, "2026-08"), []); // 예산 미확정 → 보고만
  assert.deepEqual(llmBudgetFindings(3, 10, "2026-08"), []); // 30%
  assert.match(llmBudgetFindings(8, 10, "2026-08")[0].title, /80% 도달/);
  assert.match(llmBudgetFindings(12, 10, "2026-08")[0].title, /예산 초과/);
  // 경고 finding 은 이슈 초안이 아니라 채널 경고 전용이다.
  assert.equal(llmBudgetFindings(12, 10, "2026-08")[0].repoFullName, null);
});

test("Stability 크레딧은 경고선 아래에서만 경고한다", () => {
  assert.deepEqual(stabilityFindings(725, 200), []);
  assert.match(stabilityFindings(150, 200)[0].title, /잔액 150/);
});

test("비용 기준 월은 KST 로 계산한다", () => {
  // 8/31 16:00Z 는 KST 9/1 — UTC 월로 집계하면 새 달 첫날 리포트가 지난달을 본다.
  assert.deepEqual(financeMonth(new Date("2026-08-31T16:00:00Z")), { month: "2026-09", invoiceMonth: "202609" });
  assert.deepEqual(financeMonth(new Date("2026-08-21T12:00:00Z")), { month: "2026-08", invoiceMonth: "202608" });
});
