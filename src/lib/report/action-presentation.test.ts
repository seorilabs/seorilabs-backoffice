import test from "node:test";
import assert from "node:assert/strict";
import { actionDeduplicationKey, discordActionLines } from "./action-presentation";
test("정책 제외 앱이 앞서도 등록 이슈·입력 과제를 상태와 함께 우선 표시한다", () => {
  const lines = discordActionLines([
    ...["A", "B", "C"].map((appName) => ({ appName, title: "정책 제외", status: "excluded" as const, url: null })),
    { appName: "Z", title: "검증된 개선", status: "registered", url: "https://github.com/seorilabs/example/issues/1" },
    { appName: "D", title: "필수 라벨 확인", status: "needs_input", url: null },
  ]);
  assert.match(lines[0], /등록됨.*Z.*검증된 개선/);
  assert.match(lines[1], /사람 입력 필요.*D/);
  assert.match(lines[2], /정책 제외 3개 앱/);
  assert.equal(lines.length, 3);
});
test("마커 없는 서로 다른 입력 과제·근거 부족 결과를 덮지 않는다", () => {
  const rows = [{ status: "needs_input", reason: "라벨 없음" }, { status: "needs_input", reason: "권한 없음" }, { status: "insufficient", reason: "표본 부족" }];
  assert.equal(new Set(rows.map((row) => actionDeduplicationKey({ ...row, appId: "app", title: "후보" }))).size, 3);
});
