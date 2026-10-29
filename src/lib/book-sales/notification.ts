import { Prisma } from "@prisma/client";
import { notificationDestinations } from "@/lib/notifications/destinations";
import { EMBED_COLOR } from "@/lib/notifications/style";
import { summarizeBookSales, type BookSalesSnapshot } from "./contract";

function facts(snapshot: BookSalesSnapshot | null) {
  return (snapshot?.rows ?? []).map((row) => {
    const value = row.kind === "royalty" ? { ...row, royalty: new Prisma.Decimal(row.royalty).toFixed() } : row;
    return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  }).sort();
}
export function bookSalesChangeNotification(previous: BookSalesSnapshot | null, current: BookSalesSnapshot, now: Date) {
  if (JSON.stringify(facts(previous)) === JSON.stringify(facts(current))) return null;
  const before = summarizeBookSales(previous).totals;
  const after = summarizeBookSales(current).totals!;
  const royalties = Object.entries(after.estimatedRoyalties).map(([currency, amount]) => `${currency} ${amount}`).join(", ") || "0";
  return {
    dedupeKey: `book-sales-change:${current.account}:${current.month}:${current.runId}`,
    kind: "OPERATIONAL_EVENT" as const, occurredAt: now, destinations: notificationDestinations(["ops-alerts"]),
    payload: { source: "book-sales-kdp", report: { category: "change", reason: "BOOK_SALES_FACTS_CHANGED" },
      text: [`${current.month} KDP 판매 보고서에 신규 또는 정정 데이터가 있습니다.`,
        `순판매 ${before?.netUnits ?? "미관측"} → ${after.netUnits}권, 환불 ${after.refunds}권`,
        `유료 주문 ${before?.paidOrders ?? "미관측"} → ${after.paidOrders}건, 무료 주문 ${after.freeOrders}건`,
        `KENP 읽기 ${after.pagesRead}쪽, 듣기 ${after.pagesListened}쪽`,
        `예상 로열티 ${royalties} (확정 정산액 아님)`,
        `집계 종료 ${current.periodEnd}, 마켓 현지 날짜 기준`].join("\n"),
      embed: { title: "책 판매 변경", color: EMBED_COLOR.INFO, timestamp: now.toISOString() } },
  };
}
