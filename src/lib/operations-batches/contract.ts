import { z } from "zod";

export const BATCH_SOURCE = "scheduled-batch";
export const OBSERVER_SOURCE = "operations-batch-observer";
export const SERVICE_NAMESPACES = ["platform", "data", "container-registry"] as const;
const namespace = z.enum(SERVICE_NAMESPACES);
const name = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,100}$/);
const timestamp = z.string().datetime({ offset: true });
export const cronSchema = z.object({ namespace, name, uid: name, schedule: z.string().max(100),
  timeZone: z.string().max(100), suspended: z.boolean(), lastScheduleAt: timestamp.nullable() }).strict();
export const runSchema = z.object({ id: name, namespace, name, cronUid: name,
  startedAt: timestamp, scheduledAt: timestamp, completedAt: timestamp.nullable(),
  status: z.enum(["running", "succeeded", "failed"]) }).strict();
export const localRunSchema = z.object({ id: z.string().uuid(), name: z.literal("book-sales-kdp"),
  startedAt: timestamp, completedAt: timestamp.nullable(), status: z.enum(["running", "succeeded", "failed"]),
  expected: z.number().int().min(0).max(120), verified: z.number().int().min(0).max(120) }).strict();
export const batchInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("kubernetes"), observedAt: timestamp, cronJobs: z.array(cronSchema).max(200), runs: z.array(runSchema).max(2000) }).strict(),
  z.object({ kind: z.literal("local"), run: localRunSchema }).strict(),
]);
export type BatchInput = z.infer<typeof batchInputSchema>;
export type CronObservation = z.infer<typeof cronSchema>;
export type RunObservation = z.infer<typeof runSchema>;

export function dailyWindow(now: Date) {
  // 09:00 KST = 00:00 UTC. 직전 완료된 경계만 발행한다.
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0);
  return { key: end.toISOString().slice(0, 10), start: new Date(end.getTime() - 86400_000), end };
}
export function incidentAction(status: string, startedAt: Date, latestFinalAt: Date | null) {
  if (latestFinalAt && startedAt < latestFinalAt) return "none";
  return status === "failed" ? "fail" : status === "succeeded" ? "recover" : "none";
}
export function summarizeRuns(rows: { id: string; status: string }[]) {
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  return { succeeded: unique.filter((r) => r.status === "succeeded").length,
    failed: unique.filter((r) => r.status === "failed").length, running: unique.filter((r) => r.status === "running").length };
}

/** Kubernetes가 쓰는 숫자 기반 5필드 일정. 해석 불가한 일정은 미확인으로 보고한다. */
export function expectedSchedules(cron: Pick<CronObservation, "schedule" | "timeZone" | "suspended">, start: Date, end: Date): number | null {
  if (cron.suspended) return 0;
  const fields = cron.schedule.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[\d*,/-]+$/.test(field))) return null;
  const matches = (field: string, value: number, low: number, high: number) => field.split(",").some((part) => {
    const [range, stepText] = part.split("/"); const step = stepText ? Number(stepText) : 1;
    const [a, b] = range === "*" ? [low, high] : range.split("-").map(Number);
    return step > 0 && value >= a && value <= (b ?? a) && (value - a) % step === 0;
  });
  try {
    const format = new Intl.DateTimeFormat("en-US", { timeZone: cron.timeZone, hourCycle: "h23", minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short" });
    let count = 0;
    for (let time = Math.ceil(start.getTime() / 60_000) * 60_000; time < end.getTime(); time += 60_000) {
      const parts = Object.fromEntries(format.formatToParts(new Date(time)).map((p) => [p.type, p.value]));
      const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
      const dom = matches(fields[2], Number(parts.day), 1, 31);
      const dow = matches(fields[4], weekday, 0, 7) || weekday === 0 && matches(fields[4], 7, 0, 7);
      const date = fields[2] !== "*" && fields[4] !== "*" ? dom || dow : dom && dow;
      if (matches(fields[0], Number(parts.minute), 0, 59) && matches(fields[1], Number(parts.hour), 0, 23) && date && matches(fields[3], Number(parts.month), 1, 12)) count++;
    }
    return count;
  } catch { return null; }
}
