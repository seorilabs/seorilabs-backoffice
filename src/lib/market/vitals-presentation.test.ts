import test from "node:test";
import assert from "node:assert/strict";
import { vitalsPresentation } from "./vitals-presentation";
test("Vitals 원본 백분율·반올림 분모·버전·국가·테스터를 보존하고 없는 값을 0으로 채우지 않음", () => {
  const period = { startTime: { year: 2026, month: 10, day: 7 } },
    dimensions = [
      { dimension: "countryCode", stringValue: "US" },
      { dimension: "versionCode", int64Value: "123" },
    ];
  const rows = vitalsPresentation({
    slices: [
      {
        metricSet: "crashRateMetricSet",
        cohort: "OS_PUBLIC",
        period,
        rows: [
          {
            dimensions,
            metrics: [
              { metric: "userPerceivedCrashRate", decimalValue: { value: "0.03" } },
              { metric: "distinctUsers", decimalValue: { value: "100" } },
            ],
          },
        ],
      },
      {
        metricSet: "anrRateMetricSet",
        cohort: "APP_TESTERS",
        period,
        rows: [{ dimensions, metrics: [] }],
      },
    ],
  });
  assert.equal(rows[0].rate, 0.03);
  assert.equal(rows[0].users, 100);
  assert.equal(rows[0].version, "123");
  assert.equal(rows[0].country, "US");
  assert.equal(rows[1].cohort, "앱 테스터");
  assert.equal(rows[1].rate, null);
  assert.deepEqual(vitalsPresentation({ slices: [] }), []);
});
