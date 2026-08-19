import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(
  join(process.cwd(), "src/app/api/internal/platform/operational-events/route.ts"),
  "utf8",
);

test("중복 이벤트가 알림 경로를 건너뛰지 못한다", () => {
  // 성공 응답 지점이 하나뿐이면 저장 뒤 알림 경로를 우회하는 조기 반환이 존재할 수 없다.
  const successReturns = source.match(/NextResponse\.json\(\{ ok: true/g) ?? [];
  assert.equal(successReturns.length, 1);
  assert.match(source, /\{ ok: true, duplicate \}/);
  assert.doesNotMatch(source, /if \(duplicate\) return/);
});

test("중복 여부는 응답 상태로만 구분한다", () => {
  assert.match(source, /status: duplicate \? 200 : 202/);
});
