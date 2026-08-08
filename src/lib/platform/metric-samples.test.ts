import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findMetricGaps,
  floorToHour,
  metricSampleFrom,
  type PlatformMetricSample,
} from "@/lib/platform/metric-samples";

function sample(
  capturedAt: string,
  hourlyActiveUsers = 1,
): PlatformMetricSample {
  return {
    capturedAt,
    totalUsers: 100,
    hourlyActiveUsers,
    dailyActiveUsers: 10,
    weeklyActiveUsers: 40,
  };
}

describe("플랫폼 지표 시계열", () => {
  it("집계 시각을 정시로 내려 재실행이 중복 점을 만들지 않게 한다", () => {
    // cron이 10:00:03에 돌든 10:00:47에 돌든 같은 시점이어야
    // capturedAt 유니크가 재시도를 흡수한다.
    assert.equal(
      floorToHour(new Date("2026-08-08T10:00:03.412Z")).toISOString(),
      "2026-08-08T10:00:00.000Z",
    );
    assert.equal(
      floorToHour(new Date("2026-08-08T10:59:59.999Z")).toISOString(),
      "2026-08-08T10:00:00.000Z",
    );
  });

  it("활성 정의를 값으로 함께 저장한다", () => {
    // 숫자만 남기면 나중에 다른 정의로 수집된 구간을 구분할 수 없다.
    const row = metricSampleFrom(
      {
        totalUsers: 1200,
        hourlyActiveUsers: 7,
        dailyActiveUsers: 88,
        weeklyActiveUsers: 340,
        activitySource: "session_last_seen",
        measuredAt: "2026-08-08T10:00:03Z",
      },
      new Date("2026-08-08T10:00:03Z"),
    );

    assert.equal(row.activitySource, "session_last_seen");
    assert.equal(row.hourlyActiveUsers, 7);
    assert.equal(row.capturedAt.toISOString(), "2026-08-08T10:00:00.000Z");
  });

  it("연속 구간에서는 결측이 없다", () => {
    const samples = [
      sample("2026-08-08T09:00:00.000Z"),
      sample("2026-08-08T10:00:00.000Z"),
      sample("2026-08-08T11:00:00.000Z"),
    ];
    assert.deepEqual(findMetricGaps(samples), []);
  });

  it("빠진 시각을 찾아 선을 끊을 위치를 알린다", () => {
    // 백필이 불가능하므로 이어 그리면 없는 시간에도 그 정도였다는
    // 거짓을 보여준다.
    const samples = [
      sample("2026-08-08T09:00:00.000Z"),
      sample("2026-08-08T13:00:00.000Z"), // 3시간 누락
      sample("2026-08-08T14:00:00.000Z"),
    ];

    assert.deepEqual(findMetricGaps(samples), [
      { afterIndex: 0, missingHours: 3 },
    ]);
  });

  it("결측이 여러 번이어도 각각 찾는다", () => {
    const samples = [
      sample("2026-08-08T00:00:00.000Z"),
      sample("2026-08-08T02:00:00.000Z"),
      sample("2026-08-08T03:00:00.000Z"),
      sample("2026-08-08T06:00:00.000Z"),
    ];

    assert.deepEqual(findMetricGaps(samples), [
      { afterIndex: 0, missingHours: 1 },
      { afterIndex: 2, missingHours: 2 },
    ]);
  });

  it("점이 하나뿐이면 결측을 만들지 않는다", () => {
    assert.deepEqual(findMetricGaps([sample("2026-08-08T00:00:00.000Z")]), []);
    assert.deepEqual(findMetricGaps([]), []);
  });
});
