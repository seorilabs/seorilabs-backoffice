import assert from "node:assert/strict";
import test from "node:test";
import { summarizeContentCollect, isFailedPart } from "@/lib/core/content-collect-summary";

const okResult = { upserts: { levels: 3 } };
const errResult = { error: "GA4 미설정" };

test("isFailedPart: { error } 만 실패로 본다", () => {
  assert.equal(isFailedPart(errResult), true);
  assert.equal(isFailedPart(okResult), false);
  assert.equal(isFailedPart(null), false);
});

test("summarizeContentCollect: 둘 다 성공이면 ok=true, failed 빈 배열", () => {
  const s = summarizeContentCollect([
    { name: "happyFarm", result: okResult },
    { name: "foamParty", result: okResult },
  ]);
  assert.deepEqual(s, { ok: true, failed: [] });
});

test("summarizeContentCollect: 한쪽만 실패해도 ok=false(부분 실패 표시)", () => {
  const s = summarizeContentCollect([
    { name: "happyFarm", result: okResult },
    { name: "foamParty", result: errResult },
  ]);
  assert.equal(s.ok, false);
  assert.deepEqual(s.failed, ["foamParty"]);
});

test("summarizeContentCollect: 양쪽 실패면 ok=false, failed 둘 다", () => {
  const s = summarizeContentCollect([
    { name: "happyFarm", result: errResult },
    { name: "foamParty", result: errResult },
  ]);
  assert.deepEqual(s, { ok: false, failed: ["happyFarm", "foamParty"] });
});
