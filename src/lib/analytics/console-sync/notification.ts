import { randomUUID } from "node:crypto";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { EMBED_COLOR } from "@/lib/notifications/style";
import type { collectConsoleMetrics } from "./collect";
import { consoleErrorCode } from "./oauth";

type Collected = Awaited<ReturnType<typeof collectConsoleMetrics>>;
type Failed = { state: "failed"; code: string };
type Outcome = Collected | Failed;
type RunResult = Collected | { state: "already_running" } | { state: "authenticated" };

export function consoleCollectionNotification(result: Outcome, runId: string, now = new Date()) {
  const title = result.state === "complete" ? "앱인토스 수집 완료"
    : result.state === "partial" ? "앱인토스 수집 부분 완료" : "앱인토스 수집 실패";
  const lines: string[] = [];
  if (result.state === "failed") {
    lines.push(`오류 코드: ${result.code}`, "실패 전 반영 여부는 수집 로그와 DB에서 확인해야 합니다.");
  } else {
    const count = (key: "missing" | "errors" | "skipped" | "storageErrors" | "warnings") =>
      result.results.reduce((sum, row) => sum + row[key].length, 0);
    const upsertsByListing = new Map<string, number>();
    for (const row of result.results) {
      const key = `${row.window.slug}#${row.window.miniAppId}`;
      upsertsByListing.set(key, (upsertsByListing.get(key) ?? 0) + row.upserts);
    }
    const readbackByListing = new Map(result.readback.apps.map((app) => [`${app.slug}#${app.miniAppId}`, app]));
    const blockedByListing = new Map(result.blocked.map((row) => [row.key, row.reason]));
    const listings = new Set([...upsertsByListing.keys(), ...readbackByListing.keys(), ...blockedByListing.keys()]);
    const starts = result.results.map((row) => row.window.start).sort();
    lines.push(`수집 구간: ${starts[0] ?? "조회 보류"} ~ ${result.end} (KST)`,
      `조회 ${upsertsByListing.size}개 리스팅 · 반영 ${result.results.reduce((sum, row) => sum + row.upserts, 0)}건`,
      `결측 ${count("missing")}개 리스팅·날짜 조합 · 조회 오류 ${count("errors")}건 · 저장 오류 ${count("storageErrors")}건`,
      `조회 보류 ${blockedByListing.size}개 · 저장 제외 ${count("skipped")}건 · 경고 ${count("warnings")}건`);
    if (result.state === "partial") lines.push("결측값은 0으로 채우지 않았으며 전체 수집 완료가 아닙니다.");
    for (const key of listings) {
      const reason = blockedByListing.get(key);
      const action = upsertsByListing.has(key) ? `반영 ${upsertsByListing.get(key)}건${reason ? ` · 일부 조회 보류(${reason})` : ""}`
        : `조회 보류${reason ? `(${reason})` : ""}`;
      lines.push(`- ${key === "all" ? "전체 대상" : key}: ${action} · 최신 ${readbackByListing.get(key)?.lastDate ?? "미확인"}`);
    }
  }
  return {
    dedupeKey: `ait-console-collection:${runId}`,
    kind: "OPERATIONAL_EVENT" as const,
    occurredAt: now,
    destinations: discordDestinations(["metrics-daily"]),
    payload: {
      text: lines.join("\n"),
      source: "ait_console", runId, state: result.state,
      embed: { title, timestamp: now.toISOString(), color: result.state === "complete" ? EMBED_COLOR.SUCCESS
        : result.state === "partial" ? EMBED_COLOR.WARNING : EMBED_COLOR.FAILURE },
    },
  };
}

// 수집/연결 정리가 끝난 뒤 영속 대기열에 한 번 넣는다. Discord 전송 재시도는 기존 worker가 맡는다.
export async function collectAndNotify(
  run: () => Promise<RunResult>,
  runId: string = randomUUID(),
  enqueue = enqueueNotification,
) {
  let result: RunResult | Failed;
  try { result = await run(); }
  catch (error) { result = { state: "failed", code: consoleErrorCode(error) }; }
  if (result.state === "already_running" || result.state === "authenticated") return { ...result, notification: undefined };
  try {
    const eventId = await enqueue(consoleCollectionNotification(result, runId));
    return { ...result, notification: { state: "queued" as const, eventId } };
  } catch {
    // 수집 결과는 유지한다. DB 오류 본문이나 자격증명은 출력하지 않는다.
    return { ...result, notification: { state: "failed" as const, code: "CONSOLE_NOTIFICATION_ENQUEUE_FAILED" } };
  }
}
