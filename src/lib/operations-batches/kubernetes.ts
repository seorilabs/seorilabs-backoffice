import { z } from "zod";
import { cronSchema, runSchema, SERVICE_NAMESPACES } from "./contract";

const metadata = z.object({ name: z.string().optional(), uid: z.string().optional(), creationTimestamp: z.string().optional(),
  annotations: z.record(z.string()).optional(), ownerReferences: z.array(z.object({ kind: z.string(), name: z.string(), uid: z.string() })).optional() });
const cronInput = z.object({ metadata, spec: z.object({ schedule: z.string(), timeZone: z.string().optional(), suspend: z.boolean().optional() }),
  status: z.object({ lastScheduleTime: z.string().optional() }).optional() });
const jobInput = z.object({ metadata, status: z.object({ startTime: z.string().optional(), completionTime: z.string().optional(),
  conditions: z.array(z.object({ type: z.string(), status: z.string(), lastTransitionTime: z.string().optional() })).optional() }).optional() });

/** 원본 spec, 환경변수와 오류 본문을 제외하고 허용한 식별자와 최종 상태만 반환한다. */
export function normalizeKubernetes(namespace: string, rawCrons: unknown[], rawJobs: unknown[]) {
  if (!(SERVICE_NAMESPACES as readonly string[]).includes(namespace)) throw Error("BATCH_NAMESPACE_FORBIDDEN");
  const crons = rawCrons.map((raw) => cronInput.parse(raw));
  const cronJobs = crons.map((cron) => cronSchema.parse({ namespace, name: cron.metadata.name, uid: cron.metadata.uid,
    schedule: cron.spec.schedule, timeZone: cron.spec.timeZone ?? "Etc/UTC", suspended: cron.spec.suspend ?? false,
    lastScheduleAt: cron.status?.lastScheduleTime ?? null }));
  const owners = new Map(cronJobs.map((cron) => [cron.uid, cron]));
  const runs = rawJobs.flatMap((raw) => {
    const job = jobInput.parse(raw);
    const owner = job.metadata.ownerReferences?.find((ref) => ref.kind === "CronJob" && owners.get(ref.uid)?.name === ref.name);
    if (!owner) return [];
    const final = job.status?.conditions?.find((condition) => ["Complete", "Failed"].includes(condition.type) && condition.status === "True");
    const startedAt = job.status?.startTime ?? job.metadata.creationTimestamp;
    return [runSchema.parse({ id: job.metadata.uid, namespace, name: owner.name, cronUid: owner.uid,
      startedAt, scheduledAt: job.metadata.annotations?.["batch.kubernetes.io/cronjob-scheduled-timestamp"] ?? job.metadata.creationTimestamp,
      completedAt: final ? job.status?.completionTime ?? final.lastTransitionTime ?? startedAt : null,
      status: !final ? "running" : final.type === "Complete" ? "succeeded" : "failed" })];
  });
  return { cronJobs, runs };
}
