import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Platform Fleet AgentRun을 만드는 경로가 둘이다. occurrence를 새로 만들 때의 nested create와,
 * superseded 계획만 남은 occurrence를 재사용할 때의 create다. 두 경로가 갈리면 재사용으로 만든
 * run만 라벨·우선순위·재시도 한도가 달라져 스케줄러가 다르게 다루게 된다. 그런 차이는 실행
 * 로그에 드러나지 않으므로 소스에서 고정한다.
 */
function creationFields(block: string): string[] {
  return [...block.matchAll(/^\s{8,10}([a-zA-Z]+):/gmu)].map((match) => match[1]!);
}

test("AgentRun 생성 두 경로가 같은 필드 집합을 쓴다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/control-plane/platform-fleet.ts"), "utf8");

  const reuse = /return input\.tx\.agentRun\.create\(\{\n\s*data: \{\n([\s\S]*?)\n\s*\},\n\s*\}\);/u.exec(source);
  assert.ok(reuse, "occurrence 재사용 경로의 AgentRun create를 찾지 못했다");

  const nested = /runs: \{\n\s*create: \{\n([\s\S]*?)\n\s*\},\n\s*\},/u.exec(source);
  assert.ok(nested, "occurrence 신규 생성 경로의 AgentRun create를 찾지 못했다");

  const reuseFields = creationFields(reuse[1]!);
  const nestedFields = creationFields(nested[1]!);

  // 재사용 경로만 occurrenceId를 명시한다. nested create는 부모가 암묵적으로 채운다.
  assert.deepEqual(
    reuseFields.filter((field) => field !== "occurrenceId").sort(),
    nestedFields.sort(),
    "두 생성 경로의 필드 집합이 다르다",
  );
  assert.ok(reuseFields.includes("occurrenceId"), "재사용 경로가 occurrenceId를 지정하지 않는다");

  for (const field of ["workKey", "labels", "createsPr", "priority", "maxAttempts", "taskInput"]) {
    assert.ok(nestedFields.includes(field), `기준 경로에 ${field}가 없다`);
  }
});
