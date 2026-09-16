import assert from "node:assert/strict";
import test from "node:test";
import { count, countOrDash, pct, won } from "@/lib/format/units";

test("금액은 원 기호와 천 단위 구분자로 통일한다", () => {
  assert.equal(won(45_300), "₩45,300");
  assert.equal(won(0), "₩0");
  // 소수 금액은 반올림한다. 콘솔 광고 수익이 소수로 들어온다.
  assert.equal(won(608.64), "₩609");
});

test("퍼센트는 소수 1자리가 기본이고 null 은 대시다", () => {
  // 정수로 접으면 12.4 와 11.6 이 같은 값으로 보인다.
  assert.equal(pct(12), "12.0%");
  assert.equal(pct(64.44), "64.4%");
  assert.equal(pct(null), "—");
  assert.equal(pct(undefined), "—");
  assert.equal(pct(33.333, 0), "33%");
});

test("건수는 단위를 붙일 수 있고 null 은 대시다", () => {
  assert.equal(count(1_234), "1,234");
  assert.equal(count(1_234, "명"), "1,234명");
  assert.equal(countOrDash(null, "명"), "—");
  assert.equal(countOrDash(0, "회"), "0회");
});
