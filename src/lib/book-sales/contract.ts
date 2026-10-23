import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { metricDayOf, parseMetricDay, toDbDay } from "@/lib/analytics/metric-day";

export const BOOK_SALES_SOURCE = "book-sales-kdp";
export const BOOK_SALES_ACCOUNT = "kdp-wellknowngeek";
export const bookMonthSchema = z.string().regex(/^20\d{2}-\d{2}$/).refine((v) => !!parseMetricDay(`${v}-01`));
const quantity = z.number().int().min(0).max(1_000_000_000);
const rowBase = z.object({
  date: z.string().regex(/^20\d{2}-\d{2}(?:-\d{2})?$/),
  title: z.string().min(1).max(600), identifier: z.string().regex(/^[A-Z0-9-]{5,32}$/),
  marketplace: z.string().regex(/^Amazon\.[a-z.]{2,20}$/),
  format: z.enum(["ebook", "paperback", "hardcover", "unknown"]),
}).strict();
const rowSchema = z.discriminatedUnion("kind", [
  rowBase.extend({ kind: z.literal("royalty"), format: z.enum(["ebook", "paperback", "hardcover"]),
    unitsSold: quantity, refunds: quantity, netUnits: z.number().int().min(-1_000_000_000).max(1_000_000_000),
    royalty: z.string().regex(/^-?\d{1,12}(?:\.\d{1,12})?$/), currency: z.string().regex(/^[A-Z]{3}$/),
    transactionType: z.string().min(1).max(100) }).strict(),
  rowBase.extend({ kind: z.literal("orders"), format: z.literal("unknown"), paidUnits: quantity, freeUnits: quantity }).strict(),
  rowBase.extend({ kind: z.literal("kenp"), format: z.literal("ebook"), pagesRead: quantity, pagesListened: quantity }).strict(),
]);
const common = z.object({ schemaVersion: z.literal(1), runId: z.string().uuid(), account: z.literal(BOOK_SALES_ACCOUNT),
  month: bookMonthSchema, capturedAt: z.string().datetime({ offset: true }) }).strict();
export const bookSalesInputSchema = z.discriminatedUnion("kind", [
  common.extend({ kind: z.literal("snapshot"), periodEnd: z.string(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), rows: z.array(rowSchema).max(8_000) }).strict(),
  common.extend({ kind: z.literal("failure"), errorCode: z.enum(["KDP_AUTH_REQUIRED", "KDP_DOWNLOAD_FAILED", "KDP_REPORT_INVALID", "KDP_ARCHIVE_FAILED", "KDP_BROWSER_UNAVAILABLE"]) }).strict(),
]);
export type BookSalesInput = z.infer<typeof bookSalesInputSchema>;
export type BookSalesSnapshot = Extract<BookSalesInput, { kind: "snapshot" }>;

export function parseBookSalesInput(raw: unknown, now: Date): BookSalesInput {
  const input = bookSalesInputSchema.parse(raw);
  if (new Date(input.capturedAt).getTime() > now.getTime() + 10 * 60_000) throw new Error("BOOK_SALES_FUTURE_CAPTURE");
  if (input.kind === "snapshot") {
    if (!parseMetricDay(input.periodEnd) || !input.periodEnd.startsWith(`${input.month}-`) || input.periodEnd > metricDayOf(new Date(input.capturedAt))) throw new Error("BOOK_SALES_PERIOD_INVALID");
    for (const row of input.rows) {
      if (row.date !== input.month && (!parseMetricDay(row.date) || !row.date.startsWith(`${input.month}-`) || row.date > input.periodEnd)) throw new Error("BOOK_SALES_ROW_DATE_INVALID");
      if (row.kind === "royalty" && row.netUnits !== row.unitsSold - row.refunds) throw new Error("BOOK_SALES_NET_UNITS_INVALID");
    }
  }
  return input;
}

export function snapshotRunData(input: BookSalesInput, now: Date) {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return {
    id: `book-sales:${input.runId}:${input.month}`, source: BOOK_SALES_SOURCE,
    target: `${input.account}:${input.month}`, startedAt: new Date(input.capturedAt), completedAt: now,
    status: input.kind === "snapshot" ? input.rows.length ? "observed" : "empty" : input.errorCode === "KDP_AUTH_REQUIRED" ? "needs_input" : "failed",
    dataThrough: input.kind === "snapshot" ? toDbDay(input.periodEnd) : null,
    errorCode: input.kind === "failure" ? input.errorCode : null,
    coverage: { schemaVersion: 1, digest, ...(input.kind === "snapshot" ? { snapshot: input } : {}) },
  };
}

function emptyTotals() {
  return { unitsSold: 0, refunds: 0, netUnits: 0, paidOrders: 0, freeOrders: 0, pagesRead: 0, pagesListened: 0, estimatedRoyalties: {} as Record<string, string> };
}
type Totals = ReturnType<typeof emptyTotals>;
function addRow(total: Totals, row: BookSalesSnapshot["rows"][number]) {
  if (row.kind === "orders") { total.paidOrders += row.paidUnits; total.freeOrders += row.freeUnits; }
  if (row.kind === "kenp") { total.pagesRead += row.pagesRead; total.pagesListened += row.pagesListened; }
  if (row.kind === "royalty") {
    total.unitsSold += row.unitsSold; total.refunds += row.refunds; total.netUnits += row.netUnits;
    total.estimatedRoyalties[row.currency] = new Prisma.Decimal(total.estimatedRoyalties[row.currency] ?? "0").plus(row.royalty).toFixed();
  }
}

/** 월 전체를 최신 관측으로 교체한다. 주문과 로열티의 판매량은 같은 판매의 다른 관측이다. */
export function summarizeBookSales(snapshot: BookSalesSnapshot | null) {
  const totals = snapshot ? emptyTotals() : null;
  const books = new Map<string, { identifier: string; title: string; format: string; totals: Totals }>();
  for (const row of snapshot?.rows ?? []) {
    const book = books.get(row.identifier) ?? { identifier: row.identifier, title: row.title, format: row.format, totals: emptyTotals() };
    if (row.format !== "unknown") book.format = row.format;
    addRow(book.totals, row); addRow(totals!, row); books.set(row.identifier, book);
  }
  return { totals, books: [...books.values()].sort((a, b) => a.identifier.localeCompare(b.identifier)),
    confirmedRoyalties: null, payments: null, timeZone: "marketplace-local", royaltyBasis: "estimated" };
}
