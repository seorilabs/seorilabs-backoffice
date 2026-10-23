import assert from "node:assert/strict";
import test from "node:test";
import type { collectConsoleMetrics } from "./collect";
import { collectAndNotify, consoleCollectionNotification } from "./notification";
import { reportDecision } from "@/lib/notifications/report-policy";
import { ConsoleSyncError } from "./oauth";

const sample: Awaited<ReturnType<typeof collectConsoleMetrics>> = {
  state: "partial", end: "2026-10-13", blocked: [{ key: "waiting#2", reason: "출시일 확인 필요" }],
  results: [{ window: { slug: "example", miniAppId: 1, workspaceId: 38345, start: "2026-10-10", end: "2026-10-13" }, upserts: 3,
    missing: [{ date: "2026-10-12", metrics: ["iap"] }], errors: [], skipped: [], storageErrors: [], warnings: [], verification: { expected: 3, verified: 3, mismatched: [] } }],
  readback: { apps: [{ slug: "example", miniAppId: 1, lastDate: "2026-10-11", lastCollectedAt: null, rows: 3 }], minLastDate: "2026-10-11", maxLastDate: "2026-10-11", appsWithNoData: [] },
};

test("부분 수집 알림은 실제 반영·결측·최신 날짜를 구분하고 원본을 전송하지 않는다", () => {
  const result = consoleCollectionNotification(sample, "run-1", new Date("2026-10-13T15:00:00Z"));
  assert.equal(result.kind, "OPERATIONAL_EVENT");
  assert.deepEqual(result.destinations, [{ provider: "DISCORD", key: "ops-alerts" }]);
  assert.match(result.payload.embed.title, /부분 완료/);
  assert.match(result.payload.text, /반영 3건/);
  assert.match(result.payload.text, /결측 1개 리스팅·날짜 조합/);
  assert.match(result.payload.text, /조회 보류 1개/);
  assert.match(result.payload.text, /최신 2026-10-11/);
  assert.match(result.payload.text, /전체 수집 완료가 아닙니다/);
  assert.equal(result.dedupeKey, "ait-console-collection:run-1");
});

test("정상 수집은 완료 카드로 표시한다", () => {
  const result = consoleCollectionNotification({ ...sample, state: "complete" }, "run-2");
  assert.equal(result.payload.embed.title, "앱인토스 수집 완료");
  assert.doesNotMatch(result.payload.text, /전체 수집 완료가 아닙니다/);
});

test("실패는 공개 코드만 알리고 실패 이전 저장 건수를 0으로 단정하지 않는다", async () => {
  const captured: ReturnType<typeof consoleCollectionNotification>[] = [];
  const result = await collectAndNotify(async () => { throw new Error("refresh_token=private-fixture"); }, "run-3", async (input) => {
    captured.push(input as ReturnType<typeof consoleCollectionNotification>); return "event-3";
  });
  assert.equal(result.state, "failed");
  assert.equal(captured.length, 1);
  assert.match(captured[0].payload.text, /CONSOLE_REQUEST_FAILED/);
  assert.doesNotMatch(JSON.stringify(captured), /private-fixture|반영 0건|refresh_token/);
});

test("인증 실패 코드는 보존하고 알림은 한 번 등록한다", async () => {
  let calls = 0;
  const result = await collectAndNotify(async () => { throw new ConsoleSyncError("REAUTHENTICATION_REQUIRED"); }, "run-4", async (input) => {
    calls++; assert.match(String(input.payload.text), /REAUTHENTICATION_REQUIRED/); return "event-4";
  });
  assert.equal(calls, 1);
  assert.equal(result.state, "failed");
});

test("알림 등록 실패는 수집 결과를 보존하고 별도 실패를 반환한다", async () => {
  const result = await collectAndNotify(async () => sample, "run-5", async () => { throw new Error("database-secret"); });
  assert.equal(result.state, "partial");
  assert.ok("notification" in result);
  assert.deepEqual(result.notification, { state: "failed", code: "CONSOLE_NOTIFICATION_ENQUEUE_FAILED" });
  assert.doesNotMatch(JSON.stringify(result), /database-secret/);
});

test("동시 실행 보류와 인증 검사에는 알림을 생성하지 않는다", async () => {
  for (const state of ["already_running", "authenticated"] as const) {
    const result = await collectAndNotify(async () => ({ state }), "run-6", async () => { assert.fail("수집하지 않은 실행의 알림"); });
    assert.deepEqual(result, { state, notification: undefined });
  }
});

test("120일씩 나눈 구간은 같은 리스팅 한 건으로 합산하고 보류된 리스팅도 표시한다", () => {
  const result = consoleCollectionNotification({ ...sample,
    results: [sample.results[0], { ...sample.results[0], upserts: 4 }],
    readback: { ...sample.readback, apps: [...sample.readback.apps, { slug: "waiting", miniAppId: 2, lastDate: "2026-10-09", rows: 2, lastCollectedAt: null }] },
  }, "run-7");
  assert.match(result.payload.text, /조회 1개 리스팅/);
  assert.equal(result.payload.text.split("\n").filter((line) => line.startsWith("- example#1:")).length, 1);
  assert.match(result.payload.text, /example#1: 반영 7건 · 최신 2026-10-11/);
  assert.match(result.payload.text, /waiting#2: 조회 보류.*최신 2026-10-09/);
});

test("전부 보류되어도 리스팅별 최신 날짜와 보류 사유를 남긴다", () => {
  const result = consoleCollectionNotification({ ...sample, results: [], blocked: [{ key: "example#1", reason: "공급자 요청 제한으로 실행 보류" }] }, "run-8");
  assert.match(result.payload.text, /조회 0개 리스팅/);
  assert.match(result.payload.text, /example#1: 조회 보류.*공급자 요청 제한.*최신 2026-10-11/);
});

test("승인된 앱인토스 수집 결과는 기존 억제 규칙과 구분해 발송한다", () => {
  assert.equal(reportDecision(consoleCollectionNotification(sample, "approved-run")).send, true);
});
