import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import type { DailyEdition } from "@/lib/report/daily-contract";
const resultSchema = z.object({ appId: z.string(), title: z.string(), marker: z.string().optional(), status: z.enum(["registered", "linked", "insufficient", "observing", "excluded", "needs_input"]), url: z.string().url().optional() });
/** 발행 snapshot과 동일한 DB transaction에서 visible app의 최근 결과만 고정한다. */
export async function metricIssueReportActions(now: Date, db: Prisma.TransactionClient): Promise<DailyEdition["actions"]> {
  const apps = await db.app.findMany({ where: visibleAppWhere, select: { id: true, displayName: true } });
  const events = await db.agentRunEvent.findMany({ where: { type: "METRIC_ISSUE_RESULT", createdAt: { gte: new Date(now.getTime() - 48 * 3600_000), lte: now } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const seen = new Set<string>();
  return events.flatMap((event) => {
    const parsed = resultSchema.safeParse(event.payload), app = parsed.success && apps.find((app) => app.id === parsed.data.appId);
    if (!parsed.success || !app) return [];
    const key = `${app.id}:${parsed.data.marker ?? "summary"}`;
    if (seen.has(key)) return []; seen.add(key);
    return [{ appName: app.displayName, title: parsed.data.title, status: parsed.data.status, url: parsed.data.url ?? null }];
  }).sort((a, b) => a.appName.localeCompare(b.appName) || a.title.localeCompare(b.title) || (a.url ?? "").localeCompare(b.url ?? ""));
}
