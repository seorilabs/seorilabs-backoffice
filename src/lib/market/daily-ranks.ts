import { reportFingerprint } from "@/lib/notifications/report-policy";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  makeRankReport,
  rankReportKey,
  rankReportConclusionKey,
  type RankReport,
  rankReportText,
  type RankRecord,
} from "./rank-report";
import {
  shiftMetricDay,
  toDbDay,
  parseMetricDay,
  metricDayOf,
} from "@/lib/analytics/metric-day";
import { kstDateTimeShort } from "@/lib/format/kst";
import { discordDestinations } from "@/lib/notifications/destinations";
import {
  enqueueNotification,
  requeueNotification,
  retryDeadLetterNotification,
} from "@/lib/notifications/outbox";
import { keywordMonitoring, type KeywordRow } from "./keyword-monitoring";
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
export function rankCsv(rows: KeywordRow[], day: string) {
  const header = [
    "기준일 KST",
    "앱",
    "국가",
    "검색어",
    "오늘 순위",
    "수집 상태",
    "이전 관측일",
    "이전 순위",
    "변화",
    "수집 시각 KST",
    "원본 URL",
    "설정 버전",
  ];
  const lines = rows.map((row) => [
    day,
    row.appName,
    row.country.toUpperCase(),
    row.term,
    row.rankLabel,
    row.state,
    row.previousDay,
    row.previousDay
      ? row.previousRank === null
        ? "결과 목록에 없음"
        : `${row.previousRank}위`
      : "비교 자료 없음",
    row.change,
    row.observedAt ? kstDateTimeShort(row.observedAt) : "",
    row.sourceUrl,
    row.revision,
  ]);
  return (
    "\ufeff" +
    [header, ...lines].map((line) => line.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
export function dailyRankPayload(
  rows: KeywordRow[],
  day: string,
  now: Date,
  base: string,
  history: RankRecord[] = [],
) {
  const snapshot = makeRankReport(rows, history, day, now);
  const key = rankReportKey(snapshot),
    url = `${base}/feedback/rank-reports/${key}`;
  return {
    text: rankReportText(snapshot, url),
    editable: true,
    sender: "seori",
    refDate: day,
    report: {
      category: snapshot.items.length ? "change" : "internal",
      reason: snapshot.items.length
        ? "SEARCH_VISIBILITY_CHANGE"
        : "NO_MATERIAL_RANK_CHANGE",
    },
    rankReport: snapshot,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "전체 보고서·근거 열기", url },
        ],
      },
    ],
    embed: {
      title: "App Store 검색 위치 보고서",
      color: 0x2563eb,
      footer: `기준 ${day} KST · 매일 21:40 KST`,
    },
  };
}
/** 발행 자료를 저장하고 같은 결론의 재실행은 보내지 않는다. */
export async function sendDailyKeywordRanks(
  now = new Date(),
  requestedDay?: string,
) {
  if (
    requestedDay !== undefined &&
    (!parseMetricDay(requestedDay) || requestedDay > metricDayOf(now))
  )
    throw Error("INVALID_REPORT_DAY");
  const monitoring = await keywordMonitoring(undefined, now, requestedDay);
  const history = await prisma.marketObservation.findMany({
    where: {
      kind: "keyword",
      appId: { in: monitoring.apps.map((a) => a.id) },
      day: {
        gte: toDbDay(shiftMetricDay(monitoring.day, -27)),
        lte: toDbDay(monitoring.day),
      },
      observedAt: { lte: now },
    },
  });
  const payload = dailyRankPayload(
    monitoring.rows,
    monitoring.day,
    now,
    env.optional("AUTH_URL") || "https://backoffice.vzyx.xyz",
    history,
  );
  return prisma.$transaction(
    async (tx) => {
      const snapshotKey = `keyword-report:${rankReportKey(payload.rankReport)}`;
      const snapshot = await tx.notificationEvent.findUnique({
        where: { dedupeKey: snapshotKey },
        select: { id: true },
      });
      const snapshotId =
        snapshot?.id ??
        (await enqueueNotification(
          {
            dedupeKey: snapshotKey,
            kind: "OPS_ALERT",
            payload: JSON.parse(
              JSON.stringify(payload),
            ) as Prisma.InputJsonObject,
            occurredAt: now,
            destinations: [],
          },
          tx,
        ));
      const dedupeKey = `keyword-report-day:${monitoring.day}`;
      const previous = await tx.notificationEvent.findUnique({
        where: { dedupeKey },
        select: { id: true, payload: true },
      });
      const previousReport = (
        previous?.payload as { rankReport?: RankReport } | undefined
      )?.rankReport;
      const before = previousReport?.items ?? [];
      if (
        previousReport &&
        rankReportConclusionKey(previousReport) ===
          rankReportConclusionKey(payload.rankReport)
      ) {
        await retryDeadLetterNotification(previous!.id, tx);
        return {
          day: monitoring.day,
          rows: monitoring.rows.length,
          eventId: previous!.id,
          snapshotId,
        };
      }
      const uncertain = before.some(
        (item) =>
          !monitoring.rows.some(
            (row) =>
              row.appId === item.appId &&
              row.country === item.country &&
              row.term === item.term &&
              row.state === "수집됨",
          ),
      );
      if (previous && uncertain) {
        await retryDeadLetterNotification(previous.id, tx);
        return {
          day: monitoring.day,
          rows: monitoring.rows.length,
          eventId: previous.id,
          snapshotId,
        };
      }
      const id = await enqueueNotification(
        {
          dedupeKey,
          kind: "OPS_ALERT",
          payload: JSON.parse(
            JSON.stringify(payload),
          ) as Prisma.InputJsonObject,
          occurredAt: now,
          destinations: discordDestinations(["metrics-daily"]),
        },
        tx,
      );
      if (
        previous &&
        reportFingerprint("OPS_ALERT", previous.payload) !==
          reportFingerprint("OPS_ALERT", payload)
      )
        await requeueNotification(id, tx);
      return {
        day: monitoring.day,
        rows: monitoring.rows.length,
        eventId: id,
        snapshotId,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
