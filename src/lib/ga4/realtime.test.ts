import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REALTIME_CACHE_TTL_MS,
  buildGa4RealtimeSnapshot,
  isRealtimeCacheFresh,
  parseRealtimeTotals,
  parseRealtimeVersions,
  propertyIdFromDataset,
} from "./realtime";

describe("GA4 실시간 조회", () => {
  it("export 데이터셋 이름에서 속성 ID만 꺼낸다", () => {
    const cases: Array<[string, string | null]> = [
      ["analytics_539639687", "539639687"],
      [" analytics_547294653 ", "547294653"],
      ["analytics_", null],
      ["events_20260924", null],
      ["analytics_12a", null],
    ];
    for (const [dataset, expected] of cases) {
      assert.equal(propertyIdFromDataset(dataset), expected, dataset);
    }
  });

  it("두 minuteRange 응답을 range 이름으로 나눠 읽는다", () => {
    const totals = parseRealtimeTotals({
      dimensionHeaders: [{ name: "dateRange" }],
      rows: [
        { dimensionValues: [{ value: "window" }], metricValues: [{ value: "42" }] },
        { dimensionValues: [{ value: "recent" }], metricValues: [{ value: "7" }] },
      ],
    });
    assert.deepEqual(totals, { recentActiveUsers: 7, windowActiveUsers: 42 });
  });

  it("행이 없는 응답은 실제 0명이다", () => {
    assert.deepEqual(parseRealtimeTotals({ dimensionHeaders: [{ name: "dateRange" }] }), {
      recentActiveUsers: 0,
      windowActiveUsers: 0,
    });
  });

  it("버전 분포는 헤더 순서를 따르고 사용자 수 내림차순으로 정렬한다", () => {
    const rows = parseRealtimeVersions({
      dimensionHeaders: [{ name: "appVersion" }, { name: "platform" }],
      rows: [
        { dimensionValues: [{ value: "1.4.0" }, { value: "ANDROID" }], metricValues: [{ value: "2" }] },
        { dimensionValues: [{ value: "1.4.1" }, { value: "IOS" }], metricValues: [{ value: "5" }] },
        { dimensionValues: [{ value: "1.3.0" }, { value: "WEB" }], metricValues: [{ value: "0" }] },
      ],
    });
    assert.deepEqual(rows, [
      { platform: "IOS", appVersion: "1.4.1", activeUsers: 5 },
      { platform: "ANDROID", appVersion: "1.4.0", activeUsers: 2 },
    ]);
  });

  it("합계는 성공한 앱만 더하고 실패한 앱을 위로 올린다", () => {
    const snapshot = buildGa4RealtimeSnapshot(new Date("2026-09-24T03:00:00Z"), [
      { ok: true, slug: "a", displayName: "가", recentActiveUsers: 3, windowActiveUsers: 10, versions: [] },
      { ok: false, slug: "b", displayName: "나", error: "PERMISSION_DENIED" },
      { ok: true, slug: "c", displayName: "다", recentActiveUsers: 1, windowActiveUsers: 20, versions: [] },
    ]);
    assert.equal(snapshot.totalRecentActiveUsers, 4);
    assert.equal(snapshot.totalWindowActiveUsers, 30);
    assert.deepEqual(
      snapshot.apps.map((app) => app.slug),
      ["b", "c", "a"],
    );
  });

  it("캐시는 60초 안에서만 재사용한다", () => {
    const cases: Array<[number, boolean]> = [
      [0, true],
      [REALTIME_CACHE_TTL_MS - 1, true],
      [REALTIME_CACHE_TTL_MS, false],
    ];
    for (const [elapsed, fresh] of cases) {
      assert.equal(isRealtimeCacheFresh(1_000, 1_000 + elapsed), fresh, String(elapsed));
    }
  });
});
