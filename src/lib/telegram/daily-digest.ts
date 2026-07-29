import { esc } from "@/lib/telegram/client";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_MERGED_PRS = 15;

export interface DailyDigestWindow {
  label: string;
  start: Date;
  end: Date;
}

export interface MergedPrDigestItem {
  repoFullName: string;
  number: number;
  title: string;
  baseRef: string | null;
  mergedAt: Date | null;
}

function dateLabel(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 매일 09:00 KST 실행 시 직전 KST 달력일(00:00~24:00)을 보고한다. */
export function previousKstDayWindow(now: Date): DailyDigestWindow {
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const endMs =
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) -
    KST_OFFSET_MS;
  const start = new Date(endMs - DAY_MS);
  return {
    label: dateLabel(new Date(start.getTime() + KST_OFFSET_MS)),
    start,
    end: new Date(endMs),
  };
}

export function normalizeRolloutPercent(raw: string | number): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, Math.floor(parsed)));
}

/** 날짜별 고정 버킷으로 Cron 재시도 시 Gemini 호출 여부가 바뀌지 않게 한다. */
export function dailyRolloutBucket(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

export function shouldUseDailyDigestGemini(
  date: string,
  rolloutPercent: number,
): boolean {
  const percent = normalizeRolloutPercent(rolloutPercent);
  return percent > dailyRolloutBucket(`daily-digest:${date}`);
}

export function filterDefaultBranchMerges(
  prs: MergedPrDigestItem[],
  defaultBranches: ReadonlyMap<string, string>,
): {
  mergedPrs: MergedPrDigestItem[];
  unresolvedCount: number;
} {
  const mergedPrs: MergedPrDigestItem[] = [];
  let unresolvedCount = 0;

  for (const pr of prs) {
    const defaultBranch = defaultBranches.get(pr.repoFullName);
    if (!defaultBranch) {
      unresolvedCount++;
      continue;
    }
    if (pr.baseRef === defaultBranch) mergedPrs.push(pr);
  }

  return { mergedPrs, unresolvedCount };
}

function shortRepo(repoFullName: string): string {
  return repoFullName.replace(/^seorilabs\//, "");
}

function truncateTitle(title: string, max = 120): string {
  return title.length <= max ? title : `${title.slice(0, max - 1)}…`;
}

export function formatMergedPrLines(
  prs: MergedPrDigestItem[],
  maxItems = DEFAULT_MAX_MERGED_PRS,
): string[] {
  if (prs.length === 0) return ["• 병합 없음"];

  const visible = prs.slice(0, Math.max(0, maxItems));
  const lines = visible.map((pr) => {
    const repo = shortRepo(pr.repoFullName);
    const url = `https://github.com/${pr.repoFullName}/pull/${pr.number}`;
    return `• <a href="${url}">${esc(repo)} #${pr.number}</a> ${esc(truncateTitle(pr.title))}`;
  });
  const hidden = prs.length - visible.length;
  if (hidden > 0) lines.push(`• 그 외 ${hidden}건`);
  return lines;
}

export function mergedPrPromptLines(
  prs: MergedPrDigestItem[],
  maxItems = 30,
): string[] {
  return prs
    .slice(0, maxItems)
    .map((pr) => `- ${shortRepo(pr.repoFullName)} #${pr.number}: ${truncateTitle(pr.title, 180)}`);
}
