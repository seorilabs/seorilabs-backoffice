import { randomUUID } from "node:crypto";
import { enqueueNotification } from "@/lib/notifications/outbox";
import type { collectConsoleMetrics } from "./collect";
import { consoleErrorCode } from "./oauth";
import { consoleExecutionFailed, consoleExecutionSkipped, rejectedConsoleSkips } from "./execution";
import { consoleReport, consoleVerificationLine } from "./report";

type Collected = Awaited<ReturnType<typeof collectConsoleMetrics>>;
type Failed = { state: "failed"; code: string };
type RunResult = Collected | { state: "already_running" } | { state: "authenticated" };

export function consoleCollectionNotification(result: Collected | Failed, runId: string, now = new Date(), startedAt = now) {
  const lines: string[] = [];
  if (result.state === "failed") {
    lines.push(`실패 단계: ${result.code.includes("AUTH") || result.code.includes("OAUTH") ? "인증" : "수집"}`,
      `오류 코드: ${result.code}`, "저장 여부: 확인 필요", "조치: 실행 로그와 등록된 운영 연결을 확인하세요.");
  } else {
    const count = (key: "errors" | "skipped" | "storageErrors") => result.results.reduce((n, row) => n + row[key].length, 0);
    const expected = result.results.reduce((n, row) => n + row.verification.expected, 0);
    const verified = result.results.reduce((n, row) => n + row.verification.verified, 0);
    const missing = new Map<string, Set<string>>();
    const provided = new Set<string>();
    const metrics = new Map<string, number>();
    const listingKeys = new Set<string>();
    for (const row of result.results) {
      const key = `${row.window.slug}#${row.window.miniAppId}`;
      listingKeys.add(key);
      for (const day of row.providedDates) provided.add(`${key}:${day}`);
      for (const day of row.missing) {
        const k = `${key}:${day.date}`;
        const names = missing.get(k) ?? new Set<string>();
        for (const name of day.metrics) names.add(name);
        missing.set(k, names);
      }
    }
    let partial = 0;
    for (const [key, names] of missing) {
      if (provided.has(key)) partial++;
      for (const name of names) metrics.set(name, (metrics.get(name) ?? 0) + 1);
    }
    const names: Record<string, string> = { "iaa.ANDROID": "Android 광고", "iaa.IOS": "iOS 광고", iap: "인앱결제", dau: "사용자 수", session: "이용 시간" };
    const start = result.results.map((row) => row.window.start).sort()[0];
    lines.push(`확인 기간: ${start ?? "미조회"} ~ ${result.end}`, `조회한 등록 항목: ${listingKeys.size}개`,
      `저장 ${result.results.reduce((n, row) => n + row.upserts, 0)}건, ${consoleVerificationLine(verified, expected)}`,
      `조회 오류 ${count("errors")}건, 저장 오류 ${count("storageErrors")}건, 입력 거부 ${result.results.reduce((n, row) => n + rejectedConsoleSkips(row.skipped).length, 0)}건`);
    const excluded = result.results.reduce((n, row) => n + row.skipped.filter((item) => item.category === "excluded").length, 0);
    if (excluded) lines.push(`운영 중지에 따른 정상 대상 제외: ${excluded}개`);
    if (consoleExecutionFailed(result)) {
      const codes = [...new Set(result.results.flatMap((row) => [...row.errors.map((error) => error.code), ...row.storageErrors.map((error) => error.error)]))];
      const phase = result.results.some((row) => row.verification.mismatched.length) ? "저장 대조" : count("storageErrors") ? "저장" : count("errors") ? "조회" : count("skipped") ? "입력 검증" : "조회 대상 또는 요청 제한";
      lines.push(`실패 단계: ${phase}`, ...codes.slice(0, 3).map((code) => `오류 코드: ${code}`), "조치: 실패한 항목과 운영 연결을 확인하세요.");
    }
    if (result.blocked.length) lines.push(`조회 보류: ${new Set(result.blocked.map((row) => row.key)).size}개`,
      ...[...new Set(result.blocked.map((row) => row.reason))].slice(0, 3).map((reason) => `사유: ${reason}`));
    lines.push("", `자료 제공 상태: ${consoleExecutionFailed(result) ? "실행 오류로 일부 항목 확인 보류" : missing.size ? "일부 값 미제공" : "이번 조회의 미제공 없음"}`);
    if (missing.size) lines.push(`일부 지표만 확인 ${partial}개, 모든 값 미제공 ${missing.size - partial}개`,
      [...metrics].map(([metric, n]) => `${names[metric] ?? "기타 지표"} ${n}개`).join(", "),
      "단위는 등록 항목과 날짜의 조합입니다. 지표별 숫자는 겹칠 수 있습니다.", "제공되지 않은 값은 0으로 바꾸지 않았습니다.");
    lines.push("같은 기간을 다시 조회해 갱신한 기록 수이며, 신규 이용자나 판매 건수가 아닙니다.");
  }
  return consoleReport({ runId, now, failed: consoleExecutionFailed(result), dataState: result.state, lines, startedAt, skipped: consoleExecutionSkipped(result) });
}

// Job UID를 재사용해 감시자의 종료 관측과 같은 실행으로 묶는다.
export async function collectAndNotify(run: () => Promise<RunResult>, runId: string = randomUUID(), enqueue = enqueueNotification) {
  const startedAt = new Date();
  let result: RunResult | Failed;
  try { result = await run(); }
  catch (error) { result = { state: "failed", code: consoleErrorCode(error) }; }
  if (result.state === "already_running" || result.state === "authenticated") return { ...result, notification: undefined };
  try {
    const eventId = await enqueue(consoleCollectionNotification(result, runId, new Date(), startedAt));
    return { ...result, notification: { state: "queued" as const, eventId } };
  } catch {
    return { ...result, notification: { state: "failed" as const, code: "CONSOLE_NOTIFICATION_ENQUEUE_FAILED" } };
  }
}
