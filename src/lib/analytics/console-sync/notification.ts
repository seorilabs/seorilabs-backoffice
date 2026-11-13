import { randomUUID } from "node:crypto";
import { publishConsoleReport } from "./report";
import type { collectConsoleMetrics } from "./collect";
import { consoleErrorCode } from "./oauth";
import { consoleExecutionSkipped, rejectedConsoleSkips } from "./execution";
import { consoleReport } from "./report";

type Collected = Awaited<ReturnType<typeof collectConsoleMetrics>>;
type Failed = { state: "failed"; code: string };
type RunResult = Collected | { state: "already_running" } | { state: "authenticated" };

export function consoleCollectionNotification(result: Collected | Failed, runId: string, now = new Date(), startedAt = now) {
 const lines:string[]=[];
 if(result.state === "failed") lines.push(`원인: ${result.code}`,"필요 조치: 실행 로그와 등록된 운영 연결을 확인하세요.");
 else {
  for(const row of result.results){
   const issues=[...row.errors.map(e=>e.code),...row.storageErrors.map(e=>e.error),...rejectedConsoleSkips(row.skipped).map(()=>"입력 검증 실패"),...row.verification.mismatched.map(day=>`${day} 저장 대조 불일치`),...row.missing.map(m=>`${m.date} ${m.metrics.join(", ")} 미제공`)];
   if(issues.length)lines.push(`대상: ${row.window.slug} / ${row.window.miniAppId}`,`기준 기간: ${row.window.start} ~ ${result.end}`,`실패 항목: ${issues.slice(0,12).join("; ")}`);
  }
  for(const row of result.blocked)lines.push(`대상: ${row.key}`,`원인: ${row.reason}`);
  if(lines.length)lines.push("필요 조치: 실패 항목의 공급자 권한과 원본 자료를 확인하세요.");
 }
 const failed=result.state === "failed" || lines.length>0;
 return consoleReport({runId,now,failed,dataState:result.state,lines,startedAt,skipped:consoleExecutionSkipped(result)});
}

// Job UID를 재사용해 감시자의 종료 관측과 같은 실행으로 묶는다.
export async function collectAndNotify(run: () => Promise<RunResult>, runId: string = randomUUID(), enqueue = publishConsoleReport) {
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
