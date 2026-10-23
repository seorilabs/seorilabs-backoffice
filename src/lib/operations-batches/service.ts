import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retryPrismaConflict } from "@/lib/prisma-conflict";
import { recordIncident, recoverIncident } from "@/lib/notifications/incidents";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { discordDestinations } from "@/lib/notifications/destinations";
import { EMBED_COLOR } from "@/lib/notifications/style";
import { BATCH_SOURCE, OBSERVER_SOURCE, batchInputSchema, dailyWindow, expectedSchedules, incidentAction, summarizeRuns,
  type BatchInput, type CronObservation } from "./contract";

const OBSERVER_ID = "operations-batch-observer:vzyx-cluster";
type ObserverCoverage = { cronJobs: CronObservation[]; gaps: { start: string; end: string }[] };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

async function saveRuns(tx: Prisma.TransactionClient, input: BatchInput, now: Date, activatedAt: Date) {
  const entries = input.kind === "kubernetes" ? input.runs.map((run) => ({ ...run,
    id: `batch:k8s:${run.id}`, target: `k8s:${run.namespace}:${run.name}`, expected: null, verified: null }))
    : [{ ...input.run, id: `batch:local:${input.run.id}`, target: `local:${input.run.name}`, scheduledAt: input.run.startedAt }];
  const seen = new Map((await tx.sourceCollectionRun.findMany({ where: { id: { in: entries.map((r) => r.id) } } })).map((row) => [row.id, row]));
  for (const run of entries.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))) {
    const prior = seen.get(run.id);
    // 종료된 Job에 늦게 도착한 진행 관측과 재전송은 상태를 되돌리지 않는다.
    if (prior && prior.target !== run.target) throw Error("BATCH_RUN_CONFLICT");
    if (prior && prior.status !== "running") continue;
    const startedAt = new Date(run.startedAt);
    const completedAt = run.completedAt ? new Date(run.completedAt) : null;
    if (startedAt > new Date(now.getTime() + 60_000) || completedAt && (completedAt < startedAt || completedAt > new Date(now.getTime() + 60_000))
      || (run.status === "running") !== (completedAt === null)) throw Error("BATCH_INVALID_TIME");
    const latest = await tx.sourceCollectionRun.findFirst({ where: { source: BATCH_SOURCE, target: run.target,
      status: { in: ["succeeded", "failed"] } }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
    const data = { source: BATCH_SOURCE, target: run.target, status: run.status, startedAt, completedAt, coverage: json({ ...run, lastObservedAt: now.toISOString() }) };
    await tx.sourceCollectionRun.upsert({ where: { id: run.id }, create: { id: run.id, ...data }, update: data });
    // 도입 시 남아 있는 이력은 집계에 쓰며 과거 장애의 신규 알림은 보내지 않는다.
    if (!completedAt || completedAt < activatedAt) continue;
    const action = incidentAction(run.status, startedAt, latest?.startedAt ?? null);
    if (action === "fail") await recordIncident({ source: BATCH_SOURCE, kind: run.target, severity: "warning",
      summary: `${run.name} 배치 실패`, signalId: run.id, detectedAt: completedAt,
      evidence: { impact: "이 실행의 작업 결과가 완료되지 않았습니다.", action: "배치 실행 상태와 수집 결과를 확인하세요.",
        runId: run.id, startedAt: run.startedAt, completedAt: completedAt.toISOString() } }, tx);
    if (action === "recover") await recoverIncident({ source: BATCH_SOURCE, kind: run.target, signalId: run.id, recoveredAt: completedAt }, tx);
  }
  return entries.length;
}

export async function publishBatchSummary(tx: Prisma.TransactionClient, now: Date) {
  const window = dailyWindow(now);
  const dedupeKey = `operations-batch-daily:${window.key}`;
  if (await tx.notificationEvent.findUnique({ where: { dedupeKey }, select: { id: true } })) return;
  const observer = await tx.sourceCollectionRun.findUnique({ where: { id: OBSERVER_ID } });
  if (!observer) return;
  const coverage = observer.coverage as unknown as ObserverCoverage;
  const rows = await tx.sourceCollectionRun.findMany({ where: { source: BATCH_SOURCE,
    OR: [{ completedAt: { gte: window.start, lt: window.end } }, { status: "running", startedAt: { lt: window.end } }] },
    select: { id: true, target: true, status: true, startedAt: true, coverage: true } });
  const totals = summarizeRuns(rows);
  const gaps = coverage.gaps.filter((gap) => new Date(gap.start) < window.end && new Date(gap.end) > window.start);
  const unknownCoverage = observer.startedAt > window.start || gaps.length > 0 || !observer.completedAt || observer.completedAt < window.end;
  const attention: string[] = [];
  const details = coverage.cronJobs.map((cron) => {
    const key = `k8s:${cron.namespace}:${cron.name}`;
    const runs = rows.filter((row) => row.target === key);
    const expected = expectedSchedules(cron, window.start, window.end);
    const slots = new Set(runs.map((row) => (row.coverage as { scheduledAt?: string } | null)?.scheduledAt).filter((at): at is string => !!at && new Date(at) >= window.start && new Date(at) < window.end));
    const counts = summarizeRuns(runs);
    const stateUnknown = runs.filter((row) => row.status === "running" && new Date((row.coverage as { lastObservedAt?: string } | null)?.lastObservedAt ?? row.startedAt).getTime() < window.end.getTime() - 5 * 60_000).length;
    const unobserved = expected === null ? null : Math.max(0, expected - slots.size);
    if (counts.failed || counts.running || unobserved || expected === null)
      attention.push(`${cron.namespace}/${cron.name.replace(/^backoffice-/, "")}: 실패 ${counts.failed}, 진행 ${counts.running}, 예정 미관측 ${unobserved ?? "미확인"}, 진행 중 최신 상태 미확인 ${stateUnknown}${cron.suspended ? " (일시정지)" : ""}`);
    return { key, ...counts, expected, unobserved, stateUnknown, suspended: cron.suspended };
  });
  const local = rows.filter((row) => row.target === "local:book-sales-kdp");
  if (!local.length) attention.push("KDP 로컬 수집: 실행 미관측 (매일 09:00 예정)");
  const lines = [`집계: ${window.start.toISOString().slice(0, 10)} 09:00 ~ ${window.key} 09:00 KST`,
    `서비스 CronJob ${coverage.cronJobs.length}개, KDP 로컬 수집, 개인피드 제외`,
    `관측한 실행: 성공 ${totals.succeeded}건, 실패 ${totals.failed}건, 진행 ${totals.running}건`,
    unknownCoverage ? `관측 공백 있음: 도입 전 구간 또는 감시 중단 ${gaps.length}구간. 사라진 이력과 미관측 실행의 성공 여부는 미확인입니다.` : "감시 연결 이력에 공백이 없습니다.",
    "실행 성공은 프로세스 완료 기준입니다. 수집 자료의 완성도와 저장 대조 결과는 수집별 알림에서 확인하세요.",
    ...attention.slice(0, 12), ...(attention.length > 12 ? [`그 밖의 주의 대상 ${attention.length - 12}개 (집계 원장 보존)`] : [])];
  await enqueueNotification({ dedupeKey, kind: "OPERATIONAL_EVENT", occurredAt: now, destinations: discordDestinations(["ops-alerts"]),
    payload: { report: { category: "response", reason: "USER_REQUESTED_BATCH_SUMMARY" }, source: BATCH_SOURCE,
      text: lines.join("\n"), summary: json({ ...totals, unknownCoverage, details }),
      embed: { title: "서비스 배치 일일 결과", color: totals.failed || unknownCoverage || attention.length ? EMBED_COLOR.WARNING : EMBED_COLOR.SUCCESS, timestamp: now.toISOString() } } }, tx);
}

export async function ingestBatchResults(raw: unknown, now = new Date(), db: Pick<PrismaClient, "$transaction"> = prisma) {
  const input = batchInputSchema.parse(raw);
  return retryPrismaConflict(() => db.$transaction(async (tx) => {
    let observer = await tx.sourceCollectionRun.findUnique({ where: { id: OBSERVER_ID } });
    if (input.kind === "kubernetes") {
      const observedAt = new Date(input.observedAt);
      if (Math.abs(observedAt.getTime() - now.getTime()) > 120_000) throw Error("BATCH_INVALID_TIME");
      if (observer?.completedAt && observedAt <= observer.completedAt) return { accepted: 0 };
      const prior = observer?.coverage as unknown as ObserverCoverage | undefined;
      const gaps = (prior?.gaps ?? []).filter((gap) => new Date(gap.end).getTime() > now.getTime() - 31 * 86400_000);
      if (observer?.completedAt && observedAt.getTime() - observer.completedAt.getTime() > 150_000)
        gaps.push({ start: observer.completedAt.toISOString(), end: observedAt.toISOString() });
      const data = { completedAt: observedAt, coverage: json({ cronJobs: input.cronJobs, gaps }), status: "observed" };
      observer = await tx.sourceCollectionRun.upsert({ where: { id: OBSERVER_ID },
        create: { id: OBSERVER_ID, source: OBSERVER_SOURCE, target: "vzyx-cluster", startedAt: now, ...data }, update: data });
    }
    const accepted = await saveRuns(tx, input, now, input.kind === "local" ? new Date(0) : observer?.startedAt ?? now);
    if (input.kind === "kubernetes") await publishBatchSummary(tx, now);
    return { accepted };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 55_000 }));
}
