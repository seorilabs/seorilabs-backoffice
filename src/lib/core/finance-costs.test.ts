import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGcpMonthCostSql,
  financeMonth,
  gcpBudgetWarnings,
  githubQuotaMultiplier,
  githubUsageWarnings,
  llmBudgetWarnings,
  parseBillingTable,
  renderGcpCostLines,
  stabilityWarnings,
  summarizeGithubUsage,
  type GithubUsageItem,
} from "@/lib/core/finance-costs";

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

test("공개 저장소 사용량은 포함분량을 쓰지 않는다", () => {
  // 표준 러너의 공개 저장소 사용량은 무료다. gross 는 청구 API 에 그대로 실리지만
  // 같은 금액이 discount 로 상계돼 실제 분량을 소비하지 않는다.
  const items: GithubUsageItem[] = [
    { date: "2026-08-29", sku: "Actions Linux", quantity: 669, grossAmount: 4.01, netAmount: 0, repositoryName: "seorilabs-backoffice" },
    { date: "2026-08-29", sku: "Actions Linux", quantity: 300, grossAmount: 1.8, netAmount: 0.5, repositoryName: "happy-farm" },
  ];
  const summary = summarizeGithubUsage(items, "2026-08", new Set(["seorilabs-backoffice"]));
  assert.equal(summary.quotaMinutes, 300, "비공개 저장소만 분량을 쓴다");
  assert.equal(summary.freeMinutes, 669, "공개 저장소 분은 따로 드러낸다");
  // gross·net 은 무료 여부와 무관하게 청구서 그대로 합산한다.
  assert.equal(summary.grossUsd, 5.81);
  assert.equal(summary.netUsd, 0.5);
  // 상위 소비 목록에도 공개 저장소는 오르지 않는다.
  assert.deepEqual(summary.topRepos, [{ repo: "happy-farm", quotaMinutes: 300 }]);
});

test("공개 저장소 목록을 못 읽으면 전부 분량 소비로 세어 과소 보고하지 않는다", () => {
  const items: GithubUsageItem[] = [
    { date: "2026-08-29", sku: "Actions Linux", quantity: 669, grossAmount: 4.01, netAmount: 0, repositoryName: "seorilabs-backoffice" },
  ];
  const summary = summarizeGithubUsage(items, "2026-08");
  assert.equal(summary.quotaMinutes, 669);
  assert.equal(summary.freeMinutes, 0);
});

test("공개 저장소여도 macOS 배수는 그대로 적용된다", () => {
  // 배수 계산과 공개 저장소 제외는 별개 단계다. 순서가 뒤바뀌면 무료 분이 10배로 샌다.
  const items: GithubUsageItem[] = [
    { date: "2026-08-29", sku: "Actions macOS 3-core", quantity: 41, grossAmount: 2.54, netAmount: 0, repositoryName: "seorilabs-official" },
  ];
  const summary = summarizeGithubUsage(items, "2026-08", new Set(["seorilabs-official"]));
  assert.equal(summary.quotaMinutes, 0);
  assert.equal(summary.freeMinutes, 410);
});

test("실청구가 시작되면 임계와 무관하게 초과 경고를 만든다", () => {
  const summary = summarizeGithubUsage(AUGUST_ITEMS, "2026-08");
  const warnings = githubUsageWarnings(summary, 3_000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].title, /초과 과금 \$5\.31/);
  assert.ok(warnings[0].evidence.some((line: string) => line.includes("3980분")));
});

test("실청구 전에는 70%·90% 임계로만 경고한다", () => {
  const at50 = summarizeGithubUsage([{ date: "2026-08-01", sku: "Actions Linux", quantity: 1_500, grossAmount: 9, netAmount: 0 }], "2026-08");
  assert.deepEqual(githubUsageWarnings(at50, 3_000), []);
  const at75 = summarizeGithubUsage([{ date: "2026-08-01", sku: "Actions Linux", quantity: 2_250, grossAmount: 13.5, netAmount: 0 }], "2026-08");
  assert.match(githubUsageWarnings(at75, 3_000)[0].title, /75% 소진/);
  const at95 = summarizeGithubUsage([{ date: "2026-08-01", sku: "Actions Linux", quantity: 2_850, grossAmount: 17.1, netAmount: 0 }], "2026-08");
  assert.match(githubUsageWarnings(at95, 3_000)[0].title, /초과 임박/);
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
  assert.deepEqual(gcpBudgetWarnings(50_000, 0, "202608"), []); // 예산 미확정 → 보고만
  assert.deepEqual(gcpBudgetWarnings(5_000, 10_000, "202608"), []); // 50%
  assert.match(gcpBudgetWarnings(8_000, 10_000, "202608")[0].title, /80% 도달/);
  assert.match(gcpBudgetWarnings(12_000, 10_000, "202608")[0].title, /예산 초과/);
});

test("LLM 예산 경고는 GCP 예산과 같은 70%/100% 규칙을 따른다", () => {
  assert.deepEqual(llmBudgetWarnings(3, 0, "2026-08"), []); // 예산 미확정 → 보고만
  assert.deepEqual(llmBudgetWarnings(3, 10, "2026-08"), []); // 30%
  assert.match(llmBudgetWarnings(8, 10, "2026-08")[0].title, /80% 도달/);
  assert.match(llmBudgetWarnings(12, 10, "2026-08")[0].title, /예산 초과/);
});

test("Stability 크레딧은 경고선 아래에서만 경고한다", () => {
  assert.deepEqual(stabilityWarnings(725, 200), []);
  assert.match(stabilityWarnings(150, 200)[0].title, /잔액 150/);
});

test("비용 기준 월은 KST 로 계산한다", () => {
  // 8/31 16:00Z 는 KST 9/1 — UTC 월로 집계하면 새 달 첫날 리포트가 지난달을 본다.
  assert.deepEqual(financeMonth(new Date("2026-08-31T16:00:00Z")), { month: "2026-09", invoiceMonth: "202609" });
  assert.deepEqual(financeMonth(new Date("2026-08-21T12:00:00Z")), { month: "2026-08", invoiceMonth: "202608" });
});
