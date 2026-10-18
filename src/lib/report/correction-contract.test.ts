import { test } from "node:test";
import assert from "node:assert/strict";
import { backfillGa4State } from "@/lib/analytics/observation";
test("백필은 보존 기간이 끝난 실제 관측을 지우지 않고 과거 추정 0은 복원하지 않는다", () => {
  assert.equal(backfillGa4State({ tableLanded: false, stored: true, previousState: "observed" }), "observed");
  assert.equal(backfillGa4State({ tableLanded: false, stored: true, previousState: "empty" }), "not_landed");
  assert.equal(backfillGa4State({ tableLanded: true, stored: false }), "not_landed");
});
