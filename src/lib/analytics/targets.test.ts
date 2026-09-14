import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// 대상 해석은 DB 를 읽으므로 단위 테스트로 값을 고정할 수 없다. 대신 "수집한 집합과
// 보고한 집합이 달라지는" 회귀만 코드 모양으로 막는다. 이 불일치가 합계 분모가
// 흔들린 원인 중 하나였다 — 수집은 전체 앱을 돌고 보고는 visibleAppWhere 로 걸렀다.

const COLLECTORS = [
  "src/lib/core/app-content-metrics-collect.ts",
  "src/lib/analytics/targets.ts",
];

test("소스 계약: 수집 대상 해석은 visibleAppWhere 를 거친다", () => {
  for (const path of COLLECTORS) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /where: visibleAppWhere/u, `${path} 가 비활성 앱까지 수집한다`);
  }
});

test("소스 계약: GA4 수집기는 대상 해석을 targets.ts 에만 맡긴다", () => {
  const source = readFileSync("src/lib/core/analytics-collect.ts", "utf8");
  assert.match(source, /ga4CoverageTargets\(\)/u);
  // 수집기가 스스로 앱을 다시 뒤지면 해석이 두 벌이 된다.
  assert.doesNotMatch(source, /prisma\.app\.findMany/u);
  assert.doesNotMatch(source, /resolveGa4Target/u);
});

test("소스 계약: 대상에서 빠진 앱은 skipped 로 드러난다", () => {
  const source = readFileSync("src/lib/analytics/targets.ts", "utf8");
  // 조용히 빠지면 분모가 줄어든 것을 아무도 모른다.
  assert.match(source, /skipped\.push\(app\.slug\)/u);
  assert.equal((source.match(/skipped\.push\(app\.slug\)/gu) ?? []).length, 2);
});
