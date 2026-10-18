import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { REGISTRATION_KEY } from "./queue";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import type { DailyEdition } from "@/lib/report/daily-contract";
import { actionDeduplicationKey, compareReportActions } from "@/lib/report/action-presentation";
const resultSchema = z.object({ appId: z.string(), title: z.string(), marker: z.string().optional(), reason: z.string().optional(), status: z.enum(["registered", "linked", "insufficient", "observing", "excluded", "needs_input"]), url: z.string().url().optional() });
/** 발행 snapshot과 동일한 DB transaction에서 visible app의 최근 결과만 고정한다. */
export async function metricIssueReportActions(now: Date, db: Prisma.TransactionClient): Promise<DailyEdition["actions"]> {
  const apps = await db.app.findMany({ where: visibleAppWhere, select: { id: true, displayName: true } });
  const since = new Date(now.getTime() - 48 * 3600_000);
  const runs = await db.agentRun.findMany({ where: { occurrence: { definition: { key: REGISTRATION_KEY } }, OR: [{ occurrence: { scheduledFor: { gte: since } } }, { status: "RUNNING" }] }, select: { id: true }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
  const events = await db.agentRunEvent.findMany({ where: { runId: { in: runs.map((run) => run.id) }, type: { in: ["METRIC_ISSUE_RESULT", "METRIC_REGISTRATION_APP_VISITED"] }, createdAt: { gte: new Date(now.getTime() - 48 * 3600_000), lte: now } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const rank = new Map(runs.map((run, index) => [run.id, index])), latestAppRun = new Map<string, string>();
  for (const event of events) {
    const appId = (event.payload as { appId?: string }).appId;
    if (!appId) continue;
    const prior = latestAppRun.get(appId);
    if (!prior || rank.get(event.runId)! < rank.get(prior)!) latestAppRun.set(appId, event.runId);
  }
  const seen = new Set<string>();
  return events.flatMap((event) => {
    if (event.type !== "METRIC_ISSUE_RESULT") return [];
    const parsed = resultSchema.safeParse(event.payload), app = parsed.success && apps.find((app) => app.id === parsed.data.appId);
    if (!parsed.success || !app) return [];
    // 등록·연결 이력은 보존하고 입력 과제·관찰·제외 판단은 앱별 최신 실행만 사용한다.
    if ((!parsed.data.marker || !["registered", "linked"].includes(parsed.data.status)) && latestAppRun.get(app.id) !== event.runId) return [];
    const key = actionDeduplicationKey(parsed.data);
    if (seen.has(key)) return []; seen.add(key);
    return [{ appName: app.displayName, title: parsed.data.title, status: parsed.data.status, url: parsed.data.url ?? null }];
  }).sort(compareReportActions);
}
