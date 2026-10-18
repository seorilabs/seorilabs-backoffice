import { AIT_LISTINGS, AIT_WORKSPACE_ID } from "../ait-apps";
import { MAX_DAYS_PER_APP, type ConsoleSourceTarget } from "../console-source";
import { lastElapsedMetricDay, parseMetricDay, shiftMetricDay } from "../metric-day";
import type { ConsoleSyncStatus } from "@/lib/core/console-metrics-collect";
export interface ConsoleWindow extends ConsoleSourceTarget { start: string; end: string; }
export function consoleCollectionPlan(status: ConsoleSyncStatus, now: Date, launches: Record<string, string> = {}) {
  const end = lastElapsedMetricDay(now);
  const observed = status.apps.flatMap((a) => a.lastDate && parseMetricDay(a.lastDate) && a.lastDate <= end ? [a.lastDate] : []);
  const regularStart = observed.length ? shiftMetricDay(observed.sort()[0], -2) : shiftMetricDay(end, -13);
  const windows: ConsoleWindow[] = []; const blocked: { key: string; reason: string }[] = [];
  for (const app of status.apps) {
    const key = `${app.slug}#${app.miniAppId}`;
    if (!AIT_LISTINGS.some((l) => l.appSlug === app.slug && l.miniAppId === app.miniAppId)) { blocked.push({ key, reason: "등록된 workspace·리스팅 확인 필요" }); continue; }
    if (app.lastDate && (!parseMetricDay(app.lastDate) || app.lastDate > end)) { blocked.push({ key, reason: "저장 날짜 확인 필요" }); continue; }
    let start = app.rows === 0 ? launches[key] : regularStart;
    if (app.rows > 0 && app.firstIncompleteDate) {
      if (!parseMetricDay(app.firstIncompleteDate) || app.firstIncompleteDate > end) { blocked.push({ key, reason: "미확인 관측 날짜 확인 필요" }); continue; }
      if (start && app.firstIncompleteDate < start) start = app.firstIncompleteDate;
    }
    if (!start || !parseMetricDay(start) || start > end) { blocked.push({ key, reason: "확인된 출시일 필요" }); continue; }
    for (let cursor = start; cursor <= end;) {
      const chunkEnd = [shiftMetricDay(cursor, MAX_DAYS_PER_APP - 1), end].sort()[0];
      windows.push({ slug: app.slug, miniAppId: app.miniAppId!, workspaceId: AIT_WORKSPACE_ID, start: cursor, end: chunkEnd });
      cursor = shiftMetricDay(chunkEnd, 1);
    }
  }
  if (!status.apps.length) blocked.push({ key: "all", reason: "수집 대상 없음" });
  return { end, windows, blocked };
}
