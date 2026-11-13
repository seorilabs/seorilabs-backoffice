import assert from "node:assert/strict";
import test from "node:test";
import type { collectConsoleMetrics } from "./collect";
import { collectAndNotify, consoleCollectionNotification } from "./notification";
import { reportDecision } from "@/lib/notifications/report-policy";
import { ConsoleSyncError } from "./oauth";

const sample: Awaited<ReturnType<typeof collectConsoleMetrics>> = {
  state: "partial", end: "2026-10-13", blocked: [{ key: "waiting#2", reason: "출시일 확인 필요" }],
  results: [{ window: { slug: "example", miniAppId: 1, workspaceId: 38345, start: "2026-10-10", end: "2026-10-13" }, upserts: 3, providedDates: ["2026-10-10", "2026-10-11", "2026-10-12"],
    missing: [{ date: "2026-10-12", metrics: ["iap"] }], errors: [], skipped: [], storageErrors: [], warnings: [], verification: { expected: 3, verified: 3, mismatched: [] } }],
  readback: { apps: [{ slug: "example", miniAppId: 1, lastDate: "2026-10-11", lastCollectedAt: null, rows: 3 }], minLastDate: "2026-10-11", maxLastDate: "2026-10-11", appsWithNoData: [] },
};

test("부분 수집은 실패한 대상·항목·기간만 보고하고 성공 건수는 숨긴다",()=>{
 const report=consoleCollectionNotification(sample,"run-1");
 assert.equal(report.payload.executionStatus,"failed");assert.deepEqual(report.destinations,[]);
 assert.match(report.payload.text,/example.*1/);assert.match(report.payload.text,/2026-10-12 iap 미제공/);
 assert.match(report.payload.text,/출시일 확인 필요/);assert.doesNotMatch(report.payload.text,/저장 3건|성공률|access_token/);
});
test("성공은 발송 대상에서 제외하고 누락과 실패는 보고한다",()=>{
 const healthy=consoleCollectionNotification({...sample,state:"complete",blocked:[],results:[{...sample.results[0],missing:[]}]},"ok");
 assert.equal(reportDecision(healthy).send,false);
 assert.equal(reportDecision(consoleCollectionNotification({...sample,blocked:[]},"missing")).send,true);
 const failed=consoleCollectionNotification({state:"failed",code:"CONSOLE_AUTH_REQUIRED"},"fail");
 assert.match(failed.payload.text,/CONSOLE_AUTH_REQUIRED/);assert.doesNotMatch(failed.payload.text,/저장 0/);
});
test("저장 대조 불일치는 실패한 날짜만 표시한다",()=>{
 const report=consoleCollectionNotification({...sample,blocked:[],results:[{...sample.results[0],missing:[],verification:{expected:3,verified:2,mismatched:["2026-10-12"]}}]},"mismatch");
 assert.match(report.payload.text,/2026-10-12 저장 대조 불일치/);assert.doesNotMatch(report.payload.text,/저장 3건/);
});
test("발송 경계 실패를 수집 성공으로 숨기지 않는다",async()=>{
 const made=await collectAndNotify(async()=>sample,"run",async()=>{throw Error("injected");});
 assert.deepEqual(made.notification,{state:"failed",code:"CONSOLE_NOTIFICATION_ENQUEUE_FAILED"});
});
test("연결 확인과 중복 실행은 수집 보고를 만들지 않는다",async()=>{
 for(const state of ["already_running","authenticated"] as const){let calls=0;await collectAndNotify(async()=>({state}),"run",async()=>{calls++;return "x";});assert.equal(calls,0);}
});
test("수집 예외의 비밀값은 알림 본문에 전달하지 않는다",async()=>{
 let captured="";await collectAndNotify(async()=>{throw new ConsoleSyncError("CONSOLE_AUTH_REQUIRED");},"run",async(input)=>{captured=input.payload.text;return "x";});assert.match(captured,/CONSOLE_AUTH_REQUIRED/);
});
