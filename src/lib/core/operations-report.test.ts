import assert from "node:assert/strict";
import test from "node:test";
import { kstDayStart } from "@/lib/core/operations-report";

test("야간 보고 구간은 KST 자정부터 시작한다", () => {
  assert.equal(
    kstDayStart(new Date("2026-08-17T13:30:00Z")).toISOString(),
    "2026-08-16T15:00:00.000Z",
  );
});
