import type { DailyEdition } from "./daily-contract";
type ReportAction = DailyEdition["actions"][number];
export const actionStatusLabels = { registered: "등록됨", linked: "기존 이슈와 연결", insufficient: "근거 부족", observing: "관찰 중", excluded: "정책 제외", needs_input: "사람 입력 필요" };
const priority = { registered: 0, linked: 1, needs_input: 2, observing: 3, insufficient: 4, excluded: 5 };
export const compareReportActions = (a: ReportAction, b: ReportAction) => priority[a.status] - priority[b.status] || a.appName.localeCompare(b.appName) || a.title.localeCompare(b.title) || (a.url ?? "").localeCompare(b.url ?? "");
export function actionDeduplicationKey(row: { appId: string; marker?: string; status: string; reason?: string; title: string }) {
  return JSON.stringify(row.marker ? [row.appId, row.marker] : [row.appId, row.status, row.reason ?? row.title]);
}
export function discordActionLines(actions: ReportAction[]) {
  const lines = actions.filter((action) => action.status !== "excluded").sort(compareReportActions).slice(0, 3)
    .map((action) => `- ${actionStatusLabels[action.status]} · ${action.appName}: ${action.title}${action.url ? ` ${action.url}` : ""}`);
  const excluded = new Set(actions.filter((action) => action.status === "excluded").map((action) => action.appName)).size;
  if (excluded) lines.push(`- 정책 제외 ${excluded}개 앱 · 보고 대상에는 포함합니다.`);
  return lines.length ? lines : ["- 등록할 근거를 갖춘 새 개선 후보가 없습니다."];
}
