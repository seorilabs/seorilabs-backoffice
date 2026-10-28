import type { KeywordRow } from "./keyword-monitoring";
import { kstDateTimeShort } from "@/lib/format/kst";
import { marketLabel } from "./keyword-cycle";
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
export function rankCsv(rows: KeywordRow[], day: string) {
  const header = [
    "기준일 KST",
    "앱",
    "마켓", "출처", "반환 개수", "언어",
    "국가",
    "검색어",
    "오늘 순위",
    "수집 상태",
    "이전 관측일",
    "이전 순위",
    "변화",
    "수집 시각 KST",
    "원본 URL",
    "설정 버전",
  ];
  const lines = rows.map((row) => [
    day,
    row.appName,
    marketLabel(row.market), row.source ?? "apple-search-api", row.resultCount ?? "미기록", row.language ?? "en_us",
    row.country.toUpperCase(),
    row.term,
    row.rankLabel,
    row.state,
    row.previousDay,
    row.previousDay
      ? row.previousRank === null
        ? "결과 목록에 없음"
        : `${row.previousRank}위`
      : "비교 자료 없음",
    row.change,
    row.observedAt ? kstDateTimeShort(row.observedAt) : "",
    row.sourceUrl,
    row.revision,
  ]);
  return (
    "\ufeff" +
    [header, ...lines].map((line) => line.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
export { sendCycleKeywordRanks as sendDailyKeywordRanks } from "./cycle-report";
