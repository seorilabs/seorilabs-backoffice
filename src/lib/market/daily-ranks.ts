import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { kstDateTimeShort } from "@/lib/format/kst";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification, requeueNotification } from "@/lib/notifications/outbox";
import { keywordMonitoring, type KeywordRow } from "./keyword-monitoring";
const safe = (text: string) => text.replace(/[@<>`]/g, "");
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
export function rankCsv(rows: KeywordRow[], day: string) {
  const header = ["기준일 KST", "앱", "국가", "검색어", "오늘 순위", "수집 상태", "이전 관측일", "이전 순위", "변화", "수집 시각 KST", "원본 URL", "설정 버전"];
  const lines = rows.map((row) => [day, row.appName, row.country.toUpperCase(), row.term, row.rankLabel, row.state, row.previousDay, row.previousDay ? row.previousRank === null ? "결과 목록에 없음" : `${row.previousRank}위` : "비교 자료 없음", row.change, row.observedAt ? kstDateTimeShort(row.observedAt) : "", row.sourceUrl, row.revision]);
  return "\ufeff" + [header, ...lines].map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
export function dailyRankPayload(rows: KeywordRow[], day: string, now: Date, base: string) {
  const collected = rows.filter((row) => row.state === "수집됨");
  const ids = [...new Set(rows.map((row) => row.appId))];
  const text = [`**${day} App Store 일일 검색 순위표**`, `추적 ${ids.length}개 앱 · ${rows.length}조합 / 오늘 수집 ${collected.length} · 미수집·실패 ${rows.length - collected.length}`, ""];
  for (const id of ids) {
    const own = rows.filter((row) => row.appId === id);
    text.push(`- **${safe(own[0].appName)}** · ${[...new Set(own.map((row) => row.country.toUpperCase()))].join("/")} · 수집 ${own.filter((row) => row.state === "수집됨").length}/${own.length}`);
  }
  const changes = collected.filter((row) => !["변화 없음", "첫 관측"].includes(row.change)).sort((a, b) => Math.abs((b.previousRank ?? 201) - (b.rank ?? 201)) - Math.abs((a.previousRank ?? 201) - (a.rank ?? 201))).slice(0, 5);
  text.push("", "**주요 변화 · 이전 성공 수집 대비**");
  if (!changes.length) text.push("비교 가능한 순위 변화 없음 · 첫 관측·미수집은 비교 제외");
  for (const row of changes) text.push(`- ${safe(row.appName)} · ${row.country.toUpperCase()} “${safe(row.term)}” · **${row.rankLabel}** · ${row.change} · 이전 ${row.previousDay}`);
  text.push("", `[전체 앱·검색어 순위표](${base}/feedback?date=${day}#daily-search-ranks) · 발행 시점 전체 ${rows.length}조합 CSV 첨부`, "Apple 검색 API 최대 200개 결과 순서 · 실제 기기 화면과 다를 수 있음");
  return {
    text: text.join("\n"), editable: true, sender: "seori", refDate: day,
    embed: { title: "App Store 일일 검색 순위표", color: 0x2563eb, footer: `발행 ${kstDateTimeShort(now)} KST · 매일 12:40 KST` },
    attachment: { filename: `app-store-ranks-${day}.csv`, contentType: "text/csv; charset=utf-8", base64: Buffer.from(rankCsv(rows, day)).toString("base64") },
  };
}
/** 수집 Job과 별개로 실행한다. 수집 실패일도 빈 날짜를 숨기지 않고 보고한다. */
export async function sendDailyKeywordRanks(now = new Date()) {
  const monitoring = await keywordMonitoring(undefined, now);
  const payload = dailyRankPayload(monitoring.rows, monitoring.day, now, env.optional("AUTH_URL") || "https://backoffice.vzyx.xyz");
  return prisma.$transaction(async (tx) => {
    const dedupeKey = `keyword-daily:${monitoring.day}`;
    const existing = await tx.notificationEvent.findUnique({ where: { dedupeKey }, select: { id: true } });
    const id = await enqueueNotification({ dedupeKey, kind: "OPS_ALERT", payload: payload as Prisma.InputJsonObject, occurredAt: now, destinations: discordDestinations(["metrics-daily"]) }, tx);
    if (existing) await requeueNotification(id, tx);
    return { day: monitoring.day, rows: monitoring.rows.length, eventId: id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
