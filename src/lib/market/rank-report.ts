import { createHash } from "node:crypto";
import type { KeywordRow } from "./keyword-monitoring";
import { shiftMetricDay } from "@/lib/analytics/metric-day";
import { decodeRank } from "./keyword-history";
export interface RankReportPoint {
  day: string;
  rank: number | null;
  state: "ranked" | "outside" | "missing" | "invalid";
}
export interface RankReportItem extends Omit<KeywordRow, "observedAt"> {
  observedAt: string | null;
  points: RankReportPoint[];
  reason: string;
  score: number;
}
export interface RankReport {
  version: 1;
  day: string;
  capturedAt: string;
  items: RankReportItem[];
  rows: Array<Omit<KeywordRow, "observedAt"> & { observedAt: string | null }>;
}
export interface RankRecord {
  appId: string;
  country: string;
  target: string;
  day: Date;
  value: unknown;
}
export function rankReportItems(
  rows: KeywordRow[],
  history: RankRecord[],
  day: string,
): RankReportItem[] {
  const dates = Array.from({ length: 28 }, (_, i) =>
    shiftMetricDay(day, i - 27),
  );
  return rows
    .filter((r) => r.state === "수집됨")
    .flatMap((row) => {
      const points = dates.map((date) => {
        const found = history.find(
          (h) =>
            h.appId === row.appId &&
            h.country === row.country &&
            h.target === row.term &&
            h.day.toISOString().slice(0, 10) === date,
        );
        const decoded = found
          ? decodeRank(found.value)
          : { rank: null, state: "missing" as const };
        return { day: date, ...decoded };
      });
      if (!row.previousDay) return [];
      const crossed = [10, 20, 50, 100].filter(
        (limit) =>
          (row.previousRank !== null && row.previousRank <= limit) !==
          (row.rank !== null && row.rank <= limit),
      );
      const recent = points.slice(-7),
        valid = recent.filter((p) => p.state === "ranked");
      const consecutive = recent.every((p) => p.state === "ranked");
      const monotonic =
        consecutive &&
        (recent.every((p, i) => i === 0 || p.rank! <= recent[i - 1].rank!) ||
          recent.every((p, i) => i === 0 || p.rank! >= recent[i - 1].rank!));
      const persistent =
        monotonic &&
        row.rank !== row.previousRank &&
        valid.length === 7 &&
        Math.abs(valid[0].rank! - valid[6].rank!) >= 10 &&
        Math.min(valid[0].rank!, valid[6].rank!) <= 100;
      const material =
        row.rank !== null &&
        row.previousRank !== null &&
        Math.min(row.rank, row.previousRank) <= 50 &&
        Math.abs(row.rank - row.previousRank) >= 10;
      if (!crossed.length && !persistent && !material) return [];
      const improving =
        row.rank !== null &&
        (row.previousRank === null || row.rank < row.previousRank);
      const boundary = crossed.length ? Math.min(...crossed) : null;
      const reason = boundary
        ? `상위 ${boundary}개 ${improving ? "진입" : "이탈"}`
        : persistent
          ? "최근 7일 연속 순위 변화"
          : "상위권의 뚜렷한 순위 변화";
      return [
        {
          ...row,
          observedAt: row.observedAt?.toISOString() ?? null,
          points,
          reason,
          score: boundary ? 1000 - boundary : 100,
        },
      ];
    })
    .sort((a, b) => b.score - a.score || a.appName.localeCompare(b.appName));
}
export function makeRankReport(
  rows: KeywordRow[],
  history: RankRecord[],
  day: string,
  now: Date,
): RankReport {
  return {
    version: 1,
    day,
    capturedAt: now.toISOString(),
    items: rankReportItems(rows, history, day),
    rows: rows.map((r) => ({
      ...r,
      observedAt: r.observedAt?.toISOString() ?? null,
    })),
  };
}
export function rankReportKey(report: RankReport) {
  return `${report.day}-${createHash("sha256")
    .update(
      JSON.stringify({
        day: report.day,
        items: report.items,
        rows: report.rows,
      }),
    )
    .digest("hex")
    .slice(0, 24)}`;
}
export function rankReportConclusionKey(report: RankReport) {
  return JSON.stringify(
    report.items.map((r) => [
      r.appId,
      r.country,
      r.term,
      r.rank,
      r.previousRank,
      r.previousDay,
      r.reason,
    ]),
  );
}
export const rankValue = (rank: number | null) =>
  rank === null ? "결과 목록 밖" : `${rank}위`;
export function rankConclusion(item: RankReportItem) {
  const change =
    item.reason === "상위권의 뚜렷한 순위 변화"
      ? "검색 위치가 크게 달라졌습니다"
      : item.reason === "최근 7일 연속 순위 변화"
        ? "최근 7일 동안 순위 변화가 이어졌습니다"
        : item.reason
            .replace("개 진입", "개에 진입")
            .replace("개 이탈", "개에서 이탈") + "했습니다";
  return `${item.appName.replace(/[@<>`]/g, "")} · ${item.country.toUpperCase()} “${item.term.replace(/[@<>`]/g, "")}” 검색에서 ${change}.`;
}

export function rankReportText(report: RankReport, url: string) {
  const top = report.items.slice(0, 3);
  return [
    `**${top[0] ? rankConclusion(top[0]) : "비교 가능한 중요한 순위 변화가 없습니다."}**`,
    ...top.map(
      (r) =>
        `- **${r.appName.replace(/[@<>`]/g, "")}** · ${r.country.toUpperCase()} “${r.term.replace(/[@<>`]/g, "")}”\n  ${r.previousDay} ${rankValue(r.previousRank)} → ${report.day} **${rankValue(r.rank)}** · ${r.reason}`,
    ),
    "",
    "검색 결과 위치의 변화입니다. 검색 유입·매출 증가를 뜻하지 않습니다.",
    `[전체 보고서·28일 추세·CSV](${url})`,
  ].join("\n");
}
const esc = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export function rankReportSvg(report: RankReport, days = 7, maxItems = 3) {
  const items = report.items.slice(0, maxItems),
    height = 160 + items.length * 410;
  const cards = items
    .map((r, i) => {
      const top = 140 + i * 410,
        points = r.points.slice(-days),
        x = (j: number) => 80 + (j * 840) / Math.max(1, points.length - 1),
        y = (rank: number) => top + 160 + ((rank - 1) / 199) * 150;
      let last: RankReportPoint | null = null,
        lines = "";
      points.forEach((p, j) => {
        if (p.state === "ranked" && p.rank !== null) {
          if (last?.state === "ranked" && last.rank !== null)
            lines += `<line x1="${x(j - 1)}" y1="${y(last.rank)}" x2="${x(j)}" y2="${y(p.rank)}" stroke="#2563eb" stroke-width="4"/>`;
          lines += `<circle cx="${x(j)}" cy="${y(p.rank)}" r="5" fill="#2563eb"/><text x="${x(j)}" y="${y(p.rank) - 12}" text-anchor="middle" font-size="20">${days <= 7 || j === 0 || j === points.length - 1 || j % 7 === 0 ? p.rank : ""}</text>`;
        } else
          lines += `<text x="${x(j)}" y="${top + 300}" text-anchor="middle" fill="#64748b" font-size="18">${days > 7 && j % 7 !== 0 && j !== points.length - 1 ? "" : p.state === "outside" ? "목록 밖" : p.state === "invalid" ? "비교 불가" : "미수집"}</text>`;
        last = p;
      });
      return `<g><rect x="24" y="${top - 32}" width="952" height="390" rx="16" fill="#f8fafc"/><text x="56" y="${top + 6}" font-size="32" font-weight="700">${esc(r.appName.slice(0, 30))}</text><text x="56" y="${top + 43}" font-size="24">${esc(r.country.toUpperCase() + " · " + r.term.slice(0, 52))}</text><text x="56" y="${top + 82}" font-size="28" fill="${r.rank !== null && (r.previousRank === null || r.rank < r.previousRank) ? "#047857" : "#b45309"}">${esc(rankValue(r.previousRank) + " → " + rankValue(r.rank) + " · " + r.reason)}</text><text x="56" y="${top + 116}" font-size="20" fill="#475569">비교 ${r.previousDay} → ${report.day} · 숫자가 작을수록 높은 순위</text><line x1="80" y1="${y(1)}" x2="920" y2="${y(1)}" stroke="#cbd5e1"/><line x1="80" y1="${y(200)}" x2="920" y2="${y(200)}" stroke="#cbd5e1"/>${lines}<text x="80" y="${top + 343}" font-size="20">${points[0]?.day ?? ""}</text><text x="920" y="${top + 343}" text-anchor="end" font-size="20">${report.day}</text></g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}"><rect width="1000" height="${height}" fill="white"/><g font-family="Noto Sans CJK KR, Apple SD Gothic Neo, sans-serif" fill="#0f172a"><text x="40" y="48" font-size="32" font-weight="700">${report.day} 검색 위치의 중요한 변화</text><text x="40" y="85" font-size="22" fill="#475569">App Store 검색 API · 최근 ${days}일 · 국가·검색어별 비교</text>${cards}</g></svg>`;
}

/** Discord inline은 세로 제한으로 축소되므로 큰 글자와 짧은 3개 행을 사용한다. */
export function rankDiscordSvg(report: RankReport) {
  const items = report.items.slice(0, 3);
  const hasGaps = items.some((item) =>
    item.points.slice(-7).some((point) => point.state !== "ranked"),
  );
  const offset = hasGaps ? 32 : 0,
    height = 100 + offset + items.length * 210;
  const trim = (value: string, max: number) =>
    value.length > max ? value.slice(0, max - 1) + "…" : value;
  const rows = items
    .map((r, i) => {
      const top = 118 + offset + i * 210,
        points = r.points.slice(-7),
        x = (j: number) => 560 + (j * 380) / 6,
        y = (rank: number) => top + 118 + ((rank - 1) / 199) * 46;
      let graph = "";
      points.forEach((p, j) => {
        if (p.state === "ranked" && p.rank !== null) {
          const before = points[j - 1];
          if (before?.state === "ranked" && before.rank !== null)
            graph += `<line x1="${x(j - 1)}" y1="${y(before.rank)}" x2="${x(j)}" y2="${y(p.rank)}" stroke="#2563eb" stroke-width="4"/>`;
          graph += `<circle cx="${x(j)}" cy="${y(p.rank)}" r="5" fill="#2563eb"/>`;
        } else
          graph += `<text x="${x(j)}" y="${top + 148}" text-anchor="middle" fill="#64748b" font-size="23">${p.state === "outside" ? "○" : p.state === "invalid" ? "!" : "×"}</text>`;
      });
      const color =
        r.rank !== null && (r.previousRank === null || r.rank < r.previousRank)
          ? "#047857"
          : "#b45309";
      return `<g><rect x="20" y="${top - 22}" width="960" height="200" rx="16" fill="#f8fafc"/><text x="44" y="${top + 20}" font-size="40" font-weight="700">${esc(trim(r.appName, 20))}</text><text x="44" y="${top + 61}" font-size="32">${esc(trim(r.country.toUpperCase() + " · " + r.term, 36))}</text><text x="44" y="${top + 107}" font-size="40" fill="${color}">${esc(rankValue(r.previousRank) + " → " + rankValue(r.rank))}</text><text x="950" y="${top + 107}" text-anchor="end" font-size="32" fill="${color}">${esc(r.reason)}</text><text x="44" y="${top + 160}" font-size="24" fill="#475569">비교 ${r.previousDay} → ${report.day}</text>${graph}</g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}"><rect width="1000" height="${height}" fill="#ffffff"/><g font-family="Noto Sans CJK KR, Apple SD Gothic Neo, sans-serif" fill="#0f172a"><text x="40" y="44" font-size="36" font-weight="700">${report.day} 검색 위치의 중요한 변화</text><text x="40" y="81" font-size="26" fill="#475569">이전 관측 → 기준일 · 그래프 최근 7일 · 작은 숫자가 높은 순위</text>${hasGaps ? '<text x="40" y="112" font-size="24" fill="#475569">○ 결과 목록 밖 · × 미수집 · ! 자료 오류</text>' : ""}${rows}</g></svg>`;
}
