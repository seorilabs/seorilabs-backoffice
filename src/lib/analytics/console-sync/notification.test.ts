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

test("부분 수집 알림은 실제 반영·결측·최신 날짜를 구분하고 원본을 전송하지 않는다", () => {
  const result = consoleCollectionNotification(sample, "run-1", new Date("2026-10-13T15:00:00Z"));
  assert.equal(result.kind, "OPERATIONAL_EVENT");
  assert.deepEqual(result.destinations, [{ provider: "DISCORD", key: "batch-monitoring" }]);
  assert.match(result.payload.embed.title, /실패/);
  assert.match(result.payload.text, /저장 3건/);
  assert.match(result.payload.text, /일부 지표만 확인 1개, 모든 값 미제공 0개/);
  assert.match(result.payload.text, /조회 보류: 1개/);
  assert.match(result.payload.text, /0으로 바꾸지 않았습니다/);
  assert.equal(result.dedupeKey, "ait-console-collection:run-1");
});

test("미제공만 남은 수집은 성공 카드와 자료 상태를 나눈다", () => {
  const result = consoleCollectionNotification({ ...sample, blocked: [] }, "missing-only");
  assert.equal(result.payload.embed.title, "✅ 앱인토스 지표 수집 성공");
  assert.deepEqual(result.destinations, [{ provider: "DISCORD", key: "batch-monitoring" }]);
  assert.match(result.payload.text, /자료 제공 상태: 일부 값 미제공/);
});

test("정상 수집은 완료 카드로 표시한다", () => {
  const result = consoleCollectionNotification({ ...sample, state: "complete", blocked: [], results: [{ ...sample.results[0], missing: [] }] }, "run-2");
  assert.equal(result.payload.embed.title, "✅ 앱인토스 지표 수집 성공");
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

test("같은 항목과 날짜를 중복해서 세지 않고 내부 식별자를 첫 화면에서 뺀다", () => {
  const result = consoleCollectionNotification({ ...sample, results: [sample.results[0], { ...sample.results[0], upserts: 4 }] }, "run-7");
  assert.match(result.payload.text, /등록 항목: 1개/);
  assert.match(result.payload.text, /저장 7건/);
  assert.match(result.payload.text, /일부 지표만 확인 1개/);
  assert.doesNotMatch(result.payload.text, /example#1/);
});

test("전부 보류되면 실패를 표시하고 보류 이유를 남긴다", () => {
  const result = consoleCollectionNotification({ ...sample, results: [], blocked: [{ key: "example#1", reason: "공급자 요청 제한으로 실행 보류" }] }, "run-8");
  assert.match(result.payload.embed.title, /실패/);
  assert.match(result.payload.text, /등록 항목: 0개/);
  assert.match(result.payload.text, /공급자 요청 제한/);
});

test("전혀 제공된 값이 없는 날짜는 일부 지표만 받은 날짜와 구분한다", () => {
  const result = consoleCollectionNotification({ ...sample, blocked: [], results: [{ ...sample.results[0],
    missing: [...sample.results[0].missing, { date: "2026-10-13", metrics: ["iap", "iaa.IOS"] }] }] }, "run-9");
  assert.match(result.payload.embed.title, /성공/);
  assert.match(result.payload.text, /일부 지표만 확인 1개, 모든 값 미제공 1개/);
  assert.match(result.payload.text, /iOS 광고 1개/);
});

test("승인된 앱인토스 수집 결과는 기존 억제 규칙과 구분해 발송한다", () => {
  assert.equal(reportDecision(consoleCollectionNotification(sample, "approved-run")).send, true);
});


test("140개 하루 기록의 84건 저장과 70개 부분 제공, 56개 전체 미제공을 혼동하지 않는다", () => {
  const dates = Array.from({ length: 14 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  const results = Array.from({ length: 10 }, (_, i) => {
    const providedDates = i < 6 ? dates : [];
    return { ...sample.results[0], window: { ...sample.results[0].window, slug: `app-${i}`, start: dates[0], end: dates[13] },
      providedDates, upserts: providedDates.length,
      verification: { expected: providedDates.length, verified: providedDates.length, mismatched: [] },
      missing: i === 0 ? [] : dates.map((date) => ({ date, metrics: ["iap"] })) };
  });
  const report = consoleCollectionNotification({ ...sample, end: dates[13], blocked: [], results }, "production-sized");
  assert.match(report.payload.embed.title, /성공/);
  assert.match(report.payload.text, /저장 84건/);
  assert.match(report.payload.text, /일부 지표만 확인 70개, 모든 값 미제공 56개/);
  assert.ok(report.payload.text.length < 2000);
});

test("저장 대조 실패는 확인이 필요한 건수를 직접 표시한다", () => {
  const report = consoleCollectionNotification({ ...sample, blocked: [], results: [{ ...sample.results[0], verification: { expected: 3, verified: 2, mismatched: ["2026-10-12"] } }] }, "mismatched");
  assert.match(report.payload.embed.title, /실패/);
  assert.match(report.payload.text, /확인 필요 1건/);
});
