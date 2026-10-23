import { Prisma } from "@prisma/client";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { bookSalesChangeNotification } from "./notification";
import type { BookSalesSnapshot } from "./contract";
import { prisma } from "@/lib/prisma";
import { retryPrismaConflict } from "@/lib/prisma-conflict";
import { metricDayOf } from "@/lib/analytics/metric-day";
import { BOOK_SALES_ACCOUNT, BOOK_SALES_SOURCE, bookMonthSchema, parseBookSalesInput, snapshotRunData, summarizeBookSales } from "./contract";

export interface StoredBookRun {
  id: string; target: string; status: string; startedAt: Date; completedAt: Date | null; errorCode: string | null; coverage: unknown;
}
export interface BookSalesStore {
  save(data: ReturnType<typeof snapshotRunData>): Promise<StoredBookRun>;
  latest(target: string, successOnly: boolean): Promise<StoredBookRun | null>;
  notify?: (event: NonNullable<ReturnType<typeof bookSalesChangeNotification>>) => Promise<unknown>;
}
function makeStore(db: Pick<Prisma.TransactionClient, "sourceCollectionRun" | "notificationEvent">): BookSalesStore { return {
  save: (data) => db.sourceCollectionRun.upsert({
    where: { id: data.id }, update: {}, create: { ...data, coverage: data.coverage as Prisma.InputJsonObject },
  }),
  latest: (target, successOnly) => db.sourceCollectionRun.findFirst({
    where: { source: BOOK_SALES_SOURCE, target, ...(successOnly ? { status: { in: ["observed", "empty"] } } : {}) },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
  }),
  notify: (event) => enqueueNotification(event, db),
}; }
const databaseStore = makeStore(prisma);

export async function ingestBookSales(raw: unknown, now = new Date(), store?: BookSalesStore): Promise<{ runId: string; status: string }> {
  if (!store) return retryPrismaConflict(() => prisma.$transaction((tx) => ingestBookSales(raw, now, makeStore(tx)), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  const input = parseBookSalesInput(raw, now);
  const data = snapshotRunData(input, now);
  const previous = input.kind === "snapshot" ? await store.latest(data.target, true) : null;
  const stored = await store.save(data);
  if ((stored.coverage as { digest?: string } | null)?.digest !== data.coverage.digest) throw new Error("BOOK_SALES_RUN_CONFLICT");
  if (input.kind === "snapshot" && previous?.id !== stored.id && (await store.latest(data.target, true))?.id === stored.id) {
    const prior = (previous?.coverage as { snapshot?: BookSalesSnapshot } | null)?.snapshot ?? null;
    const event = bookSalesChangeNotification(prior, input, now);
    if (event) await store.notify?.(event);
  }
  return { runId: stored.id, status: stored.status };
}

export async function readBookSales(month: string, now = new Date(), store = databaseStore) {
  bookMonthSchema.parse(month);
  if (month > metricDayOf(now).slice(0, 7)) throw new Error("BOOK_SALES_FUTURE_MONTH");
  const target = `${BOOK_SALES_ACCOUNT}:${month}`;
  const [latest, success] = await Promise.all([store.latest(target, false), store.latest(target, true)]);
  const raw = (success?.coverage as { snapshot?: unknown } | null)?.snapshot;
  const snapshot = raw ? parseBookSalesInput(raw, now) : null;
  if (success && snapshot?.kind !== "snapshot") throw new Error("BOOK_SALES_STORED_REPORT_INVALID");
  const currentMonth = metricDayOf(now).slice(0, 7);
  const recentMonth = new Date(`${month}-01T00:00:00Z`);
  recentMonth.setUTCMonth(recentMonth.getUTCMonth() + 3);
  const shouldRefresh = recentMonth.toISOString().slice(0, 7) > currentMonth;
  const state = latest && !["observed", "empty"].includes(latest.status)
    ? latest.status : !success ? "needs_input"
      : shouldRefresh && now.getTime() - success.startedAt.getTime() > 36 * 60 * 60_000 ? "stale" : success.status;
  return { account: BOOK_SALES_ACCOUNT, month, state,
    lastAttemptAt: latest?.startedAt.toISOString() ?? null,
    lastSuccessfulAt: success?.startedAt.toISOString() ?? null,
    errorCode: latest?.errorCode ?? null,
    periodEnd: snapshot?.kind === "snapshot" ? snapshot.periodEnd : null,
    sourceHash: snapshot?.kind === "snapshot" ? snapshot.sourceHash : null,
    ...summarizeBookSales(snapshot?.kind === "snapshot" ? snapshot : null) };
}
