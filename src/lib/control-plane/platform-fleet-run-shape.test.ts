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

  const reuse = /const revived = await input\.tx\.agentRun\.create\(\{\n\s*data: \{\n([\s\S]*?)\n\s*\},\n\s*\}\);/u.exec(source);
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

test("두 생성 경로가 plan 연결을 같은 헬퍼로 수행한다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/control-plane/platform-fleet.ts"), "utf8");

  // refreshPlatformSdkUpdatePlans는 `agentRunId: { not: null }`인 plan만 조회한다.
  // 어느 한 경로가 연결을 빠뜨리면 그 plan은 run 결과와 무관하게 영구히 멈춘다.
  const links = [...source.matchAll(/await linkPlatformPlanRun\(\{/gu)];
  assert.equal(links.length, 2, "plan 연결이 두 생성 경로 모두에 있어야 한다");

  assert.equal(
    /platformFleetPlan\.update\(\{[\s\S]{0,200}agentRunId/u.test(
      source.slice(source.indexOf("async function enqueueSdkUpdatePlan")),
    ),
    false,
    "enqueueSdkUpdatePlan이 헬퍼를 거치지 않고 직접 plan을 연결한다",
  );
});

test("occurrence를 재사용할 때 완료 상태와 옛 결과를 되돌린다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/control-plane/platform-fleet.ts"), "utf8");
  const reopen = /automationOccurrence\.update\(\{\n\s*where: \{ id: existing\.id \},\n\s*data: \{([\s\S]*?)\},\n\s*\}\);/u.exec(source);
  assert.ok(reopen, "occurrence 재개방 update를 찾지 못했다");
  for (const expected of ['status: "PENDING"', "completedAt: null", "result: Prisma.DbNull"]) {
    assert.ok(
      reopen[1]!.includes(expected),
      `재개방이 ${expected}를 남기지 않는다 — supersede 결과가 새 실행에 잔존한다`,
    );
  }
});

/**
 * 계약 이슈와 remediation 이슈는 둘 다 "이슈가 계획을 그대로 말한다"를 불변식으로 둔다.
 * 종전에는 remediation만 drift를 계획 내용으로 되돌리고 계약 이슈는 exact 비교에서 바로
 * 실패했다. 사람이 제목이나 본문을 한 번 고치면 그 저장소의 계약 이슈는 영원히 막혔고,
 * 실행 로그에는 409만 남아 원인이 드러나지 않았다.
 */
test("계약 이슈와 remediation 이슈가 같은 자가 치유 경로를 쓴다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/control-plane/platform-fleet.ts"), "utf8");

  const guard = /if \(\n\s*issue\n\s*&& \(\n([\s\S]*?)\n\s*\)\n\s*\) \{\n\s*await client\.updateIssue\(/u.exec(source);
  assert.ok(guard, "이슈 drift 복구 분기를 찾지 못했다");
  assert.match(guard[1]!, /!remediationIssueMatches\(issue, issueTask\)/u);
  assert.match(guard[1]!, /!contractIssueMatches\(issue, issueTask\)/u);

  // 단언은 같은 비교 함수에서 파생해야 한다. 둘이 갈리면 복구한 뒤에도 단언이 실패한다.
  const assertion = /function assertContractIssueReadback\([\s\S]*?\n\}/u.exec(source);
  assert.ok(assertion, "계약 이슈 단언을 찾지 못했다");
  assert.match(assertion[0]!, /!contractIssueMatches\(issue, task\)/u);
  assert.doesNotMatch(assertion[0]!, /issue\.title !== task\.title/u);
});
