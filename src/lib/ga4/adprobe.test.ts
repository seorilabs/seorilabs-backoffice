import assert from "node:assert/strict";
import test from "node:test";
import { mapAdProbeRow } from "@/lib/ga4/bigquery";

// mapAdProbeRow 는 BigQuery 응답 1행을 Ga4AdProbe 로 매핑하는 순수 함수.
// SQL 조립과 분리해 매핑(숫자 변환·통화 정규화)의 회귀를 잡는다.

test("mapAdProbeRow: 정상 행 매핑(추정수익 소수점 유지)", () => {
  const out = mapAdProbeRow({
    ad_impressions: 1200,
    rewarded_impressions: 340,
    impressions_with_value: 1180,
    est_revenue: 12.3456,
    currencies: "KRW",
    broad_ad_events: 4200,
  });
  assert.deepEqual(out, {
    adImpressions: 1200,
    rewardedImpressions: 340,
    impressionsWithValue: 1180,
    estRevenue: 12.3456,
    currencies: "KRW",
    broadAdEvents: 4200,
  });
});

test("mapAdProbeRow: BigQuery 가 값 객체({value})로 줘도 num 이 벗겨낸다", () => {
  const out = mapAdProbeRow({
    ad_impressions: { value: "1200" },
    impressions_with_value: { value: "1180" },
    est_revenue: { value: "9.5" },
  });
  assert.equal(out.adImpressions, 1200);
  assert.equal(out.impressionsWithValue, 1180);
  assert.equal(out.estRevenue, 9.5);
});

test("mapAdProbeRow: currencies 빈 문자열/공백은 null 로 정규화", () => {
  assert.equal(mapAdProbeRow({ currencies: "" }).currencies, null);
  assert.equal(mapAdProbeRow({ currencies: "   " }).currencies, null);
  assert.equal(mapAdProbeRow({ currencies: null }).currencies, null);
  assert.equal(mapAdProbeRow({}).currencies, null);
});

test("mapAdProbeRow: 빈 행(집계 대상 없음)은 전부 0/null", () => {
  const out = mapAdProbeRow({});
  assert.deepEqual(out, {
    adImpressions: 0,
    rewardedImpressions: 0,
    impressionsWithValue: 0,
    estRevenue: 0,
    currencies: null,
    broadAdEvents: 0,
  });
});

test("mapAdProbeRow: 노출 없으면 수익도 0 (SQL 조건 일치의 매핑측 계약)", () => {
  const out = mapAdProbeRow({
    ad_impressions: 0,
    rewarded_impressions: 0,
    impressions_with_value: 0,
    est_revenue: 0,
    currencies: null,
    broad_ad_events: 15,
  });
  assert.equal(out.adImpressions, 0);
  assert.equal(out.impressionsWithValue, 0);
  assert.equal(out.estRevenue, 0);
  assert.equal(out.currencies, null);
  assert.equal(out.broadAdEvents, 15);
});
