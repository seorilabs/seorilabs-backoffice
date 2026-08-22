import { env } from "@/lib/env";
import { runQuery } from "@/lib/ga4/bigquery";
import type { PatrolFinding } from "@/lib/discord/teammate-findings";

// 서리 파이낸스 순찰의 비용 수집. 소스 3종은 전부 선택적(optional env)이며,
// 미설정 소스는 조용히 건너뛰지 않고 리포트에 "미설정" 으로 드러낸다.
// 경고 판정은 순수 함수로 분리해 테스트로 고정한다.

export const GITHUB_QUOTA_WARN_PCT = 70;
export const GITHUB_QUOTA_ALERT_PCT = 90;
const USD_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const KRW_FORMAT = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

function usd(value: number): string {
  return `$${USD_FORMAT.format(value)}`;
}

function krw(value: number): string {
  return `₩${KRW_FORMAT.format(value)}`;
}

function warning(input: Omit<PatrolFinding, "status" | "repoFullName" | "labels">): PatrolFinding {
  // 비용 경고는 이슈 초안이 아니라 채널 경고 전용이다(repoFullName null).
  return { ...input, repoFullName: null, labels: [], status: "skipped" };
}

// ── GitHub Actions 분량 ─────────────────────────────────────────────────────

export interface GithubUsageItem {
  date?: string;
  product?: string;
  sku?: string;
  quantity?: number;
  grossAmount?: number;
  netAmount?: number;
  repositoryName?: string;
}

/**
 * SKU 별 포함분량 환산 배수. hosted 러너 분(minute) SKU 만 분량을 소비하고
 * (macOS 10x, Windows 2x), storage/packages 는 별도 계정이라 0.
 */
export function githubQuotaMultiplier(sku: string): number {
  if (!/^actions /i.test(sku)) return 0;
  if (/storage/i.test(sku)) return 0;
  if (/macos/i.test(sku)) return 10;
  if (/windows/i.test(sku)) return 2;
  return 1;
}

export interface GithubUsageSummary {
  month: string; // "YYYY-MM"
  quotaMinutes: number;
  grossUsd: number;
  netUsd: number;
  topRepos: Array<{ repo: string; quotaMinutes: number }>;
}

export function summarizeGithubUsage(items: readonly GithubUsageItem[], month: string): GithubUsageSummary {
  let quotaMinutes = 0;
  let grossUsd = 0;
  let netUsd = 0;
  const byRepo = new Map<string, number>();
  for (const item of items) {
    if (!item.date?.startsWith(month)) continue;
    grossUsd += item.grossAmount ?? 0;
    netUsd += item.netAmount ?? 0;
    const minutes = (item.quantity ?? 0) * githubQuotaMultiplier(item.sku ?? "");
    if (minutes <= 0) continue;
    quotaMinutes += minutes;
    const repo = item.repositoryName || "(repo 미상)";
    byRepo.set(repo, (byRepo.get(repo) ?? 0) + minutes);
  }
  const topRepos = [...byRepo.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([repo, minutes]) => ({ repo, quotaMinutes: Math.round(minutes) }));
  return {
    month,
    quotaMinutes: Math.round(quotaMinutes),
    grossUsd: Math.round(grossUsd * 100) / 100,
    netUsd: Math.round(netUsd * 1000) / 1000,
    topRepos,
  };
}

export function githubUsageFindings(summary: GithubUsageSummary, includedMinutes: number): PatrolFinding[] {
  const findings: PatrolFinding[] = [];
  const pct = includedMinutes > 0 ? Math.round((summary.quotaMinutes / includedMinutes) * 100) : 0;
  const topLine = summary.topRepos
    .map((entry) => `${entry.repo} ${entry.quotaMinutes}분`)
    .join(", ");
  if (summary.netUsd > 0) {
    findings.push(warning({
      key: `gh-overage:${summary.month}`,
      title: `GitHub Actions 초과 과금 ${usd(summary.netUsd)} 발생`,
      detail: `${summary.month} hosted 분량이 포함분량을 넘어 실제 청구가 시작됐다. hosted 러너를 타는 워크플로를 ARC 로 돌리거나 빈도를 줄여야 한다.`,
      evidence: [
        `${summary.month} 환산 사용량 ${summary.quotaMinutes}분 / 포함 ${includedMinutes}분 (${pct}%)`,
        `gross ${usd(summary.grossUsd)} · 실청구 ${usd(summary.netUsd)}`,
        ...(topLine ? [`상위 소비: ${topLine}`] : []),
      ],
    }));
  } else if (pct >= GITHUB_QUOTA_ALERT_PCT) {
    findings.push(warning({
      key: `gh-quota-90:${summary.month}`,
      title: `GitHub Actions 포함분량 ${pct}% 소진 — 초과 임박`,
      detail: `${summary.month} 환산 사용량이 포함분량의 ${GITHUB_QUOTA_ALERT_PCT}% 를 넘었다. 이대로면 월내 초과 과금이 시작된다.`,
      evidence: [
        `환산 사용량 ${summary.quotaMinutes}분 / 포함 ${includedMinutes}분`,
        ...(topLine ? [`상위 소비: ${topLine}`] : []),
      ],
    }));
  } else if (pct >= GITHUB_QUOTA_WARN_PCT) {
    findings.push(warning({
      key: `gh-quota-70:${summary.month}`,
      title: `GitHub Actions 포함분량 ${pct}% 소진`,
      detail: `${summary.month} 환산 사용량이 포함분량의 ${GITHUB_QUOTA_WARN_PCT}% 를 넘었다.`,
      evidence: [
        `환산 사용량 ${summary.quotaMinutes}분 / 포함 ${includedMinutes}분`,
        ...(topLine ? [`상위 소비: ${topLine}`] : []),
      ],
    }));
  }
  return findings;
}

async function fetchGithubUsage(token: string, now: Date): Promise<GithubUsageItem[]> {
  const response = await fetch(
    `https://api.github.com/orgs/${env.githubOrg()}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`GitHub billing usage HTTP ${response.status}`);
  const json = (await response.json()) as { usageItems?: GithubUsageItem[] };
  return json.usageItems ?? [];
}

// ── GCP billing export(BigQuery) ────────────────────────────────────────────

export interface GcpCostRow {
  project_id: string | null;
  currency: string;
  net_cost: number;
}

/** billing export 테이블 경로 "project.dataset.table" 파싱(순수). */
export function parseBillingTable(path: string): { project: string; dataset: string; table: string } | null {
  const parts = path.trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  return { project: parts[0], dataset: parts[1], table: parts[2] };
}

/** 이번 청구월(invoice.month, "YYYYMM") 프로젝트별 순비용 SQL(순수). credits 반영. */
export function buildGcpMonthCostSql(tablePath: string, invoiceMonth: string): string {
  return `
    SELECT
      project.id AS project_id,
      currency,
      ROUND(SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 2) AS net_cost
    FROM \`${tablePath}\`
    WHERE invoice.month = '${invoiceMonth}'
    GROUP BY project_id, currency
    ORDER BY net_cost DESC`;
}

export function renderGcpCostLines(rows: readonly GcpCostRow[]): { total: number; currency: string; lines: string[] } {
  const currency = rows[0]?.currency ?? "KRW";
  const format = (value: number) => (currency === "KRW" ? krw(value) : `${USD_FORMAT.format(value)} ${currency}`);
  let total = 0;
  const lines: string[] = [];
  for (const row of rows) {
    total += row.net_cost;
    if (Math.abs(row.net_cost) >= 1 && lines.length < 5) {
      lines.push(`  - ${row.project_id ?? "(프로젝트 미상)"}: ${format(Math.round(row.net_cost * 100) / 100)}`);
    }
  }
  total = Math.round(total * 100) / 100;
  return { total, currency, lines: [`GCP 이번 달 순비용 ${format(total)}`, ...lines] };
}

export function gcpBudgetFindings(totalKrw: number, budgetKrw: number, invoiceMonth: string): PatrolFinding[] {
  if (budgetKrw <= 0) return []; // 예산 미확정 — 보고만 하고 경고하지 않는다.
  const pct = Math.round((totalKrw / budgetKrw) * 100);
  if (pct < GITHUB_QUOTA_WARN_PCT) return [];
  const over = pct >= 100;
  return [warning({
    key: `gcp-budget:${invoiceMonth}`,
    title: over
      ? `GCP 월 예산 초과 (${pct}%)`
      : `GCP 월 예산 ${pct}% 도달`,
    detail: over
      ? `이번 달 GCP 순비용이 예산 ${krw(budgetKrw)} 을 넘었다.`
      : `이번 달 GCP 순비용이 예산 ${krw(budgetKrw)} 의 ${pct}% 에 도달했다.`,
    evidence: [`이번 달 순비용 ${krw(totalKrw)} / 예산 ${krw(budgetKrw)}`],
  })];
}

// ── Stability AI 크레딧 ─────────────────────────────────────────────────────

async function fetchStabilityCredits(key: string): Promise<number> {
  const response = await fetch("https://api.stability.ai/v1/user/balance", {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Stability balance HTTP ${response.status}`);
  const json = (await response.json()) as { credits?: number };
  if (typeof json.credits !== "number") throw new Error("Stability balance 응답에 credits 없음");
  return json.credits;
}

export function stabilityFindings(credits: number, minCredits: number): PatrolFinding[] {
  if (credits >= minCredits) return [];
  return [warning({
    key: "stability-credits-low",
    title: `Stability 크레딧 잔액 ${Math.round(credits)} — 충전 필요`,
    detail: `게임 BGM/SFX 생성용 Stability 크레딧이 경고선(${minCredits}) 아래다. 소진되면 game-sound-pipeline 생성이 실패한다.`,
    evidence: [`잔액 ${Math.round(credits)} 크레딧 < 경고선 ${minCredits}`],
  })];
}

// ── 수집 본체 ───────────────────────────────────────────────────────────────

export interface FinanceCollectResult {
  findings: PatrolFinding[];
  summaryLines: string[];
}

/** KST 기준 이번 달("YYYY-MM" / invoice "YYYYMM"). */
export function financeMonth(now: Date): { month: string; invoiceMonth: string } {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const month = kst.toISOString().slice(0, 7);
  return { month, invoiceMonth: month.replace("-", "") };
}

export async function collectFinanceCosts(now: Date): Promise<FinanceCollectResult> {
  const { month, invoiceMonth } = financeMonth(now);
  const findings: PatrolFinding[] = [];
  const summaryLines: string[] = [`이번 달(${month}) 종량제 현황`];

  // GitHub Actions 분량
  const githubToken = env.githubBillingToken();
  if (!githubToken) {
    summaryLines.push("- GitHub: 미설정 (GITHUB_BILLING_TOKEN 없음)");
  } else {
    try {
      const items = await fetchGithubUsage(githubToken, now);
      const summary = summarizeGithubUsage(items, month);
      const included = env.githubIncludedQuotaMinutes();
      const pct = included > 0 ? Math.round((summary.quotaMinutes / included) * 100) : 0;
      summaryLines.push(
        `- GitHub Actions: 환산 ${summary.quotaMinutes}분/${included}분 (${pct}%) · gross ${usd(summary.grossUsd)} · 실청구 ${usd(summary.netUsd)}`,
      );
      findings.push(...githubUsageFindings(summary, included));
    } catch (error) {
      summaryLines.push(`- GitHub: 조회 실패 (${error instanceof Error ? error.message : "error"})`);
    }
  }

  // GCP billing export
  const billingTable = env.gcpBillingExportTable();
  const parsed = billingTable ? parseBillingTable(billingTable) : null;
  if (!parsed) {
    summaryLines.push("- GCP: 미설정 (GCP_BILLING_EXPORT_TABLE 없음)");
  } else {
    try {
      const rows = await runQuery<GcpCostRow>(
        parsed.project,
        parsed.dataset,
        buildGcpMonthCostSql(billingTable, invoiceMonth),
      );
      const rendered = renderGcpCostLines(rows.map((row) => ({ ...row, net_cost: Number(row.net_cost) })));
      summaryLines.push(`- ${rendered.lines[0]}`, ...rendered.lines.slice(1));
      if (rendered.currency === "KRW") {
        findings.push(...gcpBudgetFindings(rendered.total, env.gcpMonthlyBudgetKrw(), invoiceMonth));
      }
    } catch (error) {
      summaryLines.push(`- GCP: 조회 실패 (${error instanceof Error ? error.message : "error"})`);
    }
  }

  // Stability 크레딧
  const stabilityKey = env.stabilityApiKey();
  if (!stabilityKey) {
    summaryLines.push("- Stability: 미설정 (STABILITY_API_KEY 없음)");
  } else {
    try {
      const credits = await fetchStabilityCredits(stabilityKey);
      summaryLines.push(`- Stability 크레딧: ${Math.round(credits)}`);
      findings.push(...stabilityFindings(credits, env.stabilityMinCredits()));
    } catch (error) {
      summaryLines.push(`- Stability: 조회 실패 (${error instanceof Error ? error.message : "error"})`);
    }
  }

  return { findings, summaryLines };
}
