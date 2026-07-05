import assert from "node:assert/strict";
import test from "node:test";
import { decideLocation } from "@/lib/ga4/bigquery";

test("decideLocation: override 가 최우선", () => {
  assert.equal(
    decideLocation({ override: "asia-northeast3", cached: "US", fetched: "europe-west1" }),
    "asia-northeast3",
  );
});

test("decideLocation: override 없으면 캐시", () => {
  assert.equal(decideLocation({ cached: "asia-southeast3", fetched: "US" }), "asia-southeast3");
});

test("decideLocation: 캐시 없으면 메타 조회값", () => {
  assert.equal(decideLocation({ fetched: "asia-northeast3" }), "asia-northeast3");
});

test("decideLocation: 셋 다 없으면 US 폴백 대신 에러(비US 리전 오조회 방지)", () => {
  assert.throws(() => decideLocation({ fetched: null }), /location 을 확인할 수 없음/);
  assert.throws(() => decideLocation({}), /location 을 확인할 수 없음/);
});

test("decideLocation: 공백 override 는 무시하고 폴백 체인", () => {
  assert.equal(decideLocation({ override: "  ", cached: "asia-northeast3" }), "asia-northeast3");
});
