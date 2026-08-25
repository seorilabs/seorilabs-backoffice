import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOLS, runTool } from "@/lib/ai/tools";

// 팀원 멘션이 실데이터를 조회할 수 있는 전제: 도구가 레지스트리에 실려 모델
// 프롬프트에 노출되고, runTool 스위치가 해당 이름을 처리한다.
const DATA_TOOLS = [
  "app_metrics",
  "console_metrics",
  "list_releases",
  "list_incidents",
  "list_workflow_failures",
  "review_summary",
  "teammate_activity",
  "cost_summary",
];

test("지표·릴리즈·장애·리뷰·비용 조회 도구가 레지스트리에 등록되어 있다", () => {
  const names = new Set(TOOLS.map((tool) => tool.name));
  for (const name of DATA_TOOLS) assert.ok(names.has(name), `${name} 미등록`);
  assert.equal(names.size, TOOLS.length, "도구 이름 중복");
  for (const tool of TOOLS) assert.ok(tool.description.trim().length > 0, `${tool.name} 설명 없음`);
});

test("slug 필수 도구는 인자 없이 DB 접근 전에 안내를 돌려준다", async () => {
  assert.equal(await runTool("app_metrics"), "slug 인자가 필요합니다.");
  assert.equal(await runTool("console_metrics"), "slug 인자가 필요합니다.");
});

test("등록되지 않은 도구 이름은 명시적 안내를 돌려준다", async () => {
  assert.match(await runTool("unknown_tool"), /알 수 없는 도구/);
});
