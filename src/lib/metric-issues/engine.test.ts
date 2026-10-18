import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateMarker, registerFixedCandidates, type RegistrationPorts } from "./engine";
import type { Candidate, MetricFact, RegistrationPolicy } from "./contracts";
import { IssuePostRejected } from "./post-outcome";
const candidate: Candidate = { title: "첫 행동을 기록하도록 이벤트 계약을 맞춘다", kind: "instrumentation", problemKey: "first-action-contract", customerProblem: "행동이 기록되지 않는다", outcome: "핵심 행동을 기록한다", scope: ["events.ts"], acceptanceCriteria: ["정해진 인자를 기록한다", "중복 기록이 없다"], validation: ["개발 환경 전송 경로 검증"], proof: { path: "events.ts", line: 1, excerpt: 'send("action", {})', contractPath: "contract.ts", contractExcerpt: 'required: ["id"]', expected: "id를 기록한다", actual: "id가 없다", reproduction: "행동 실행" } };
const fact: MetricFact = { metric: "ga4_dau", day: "2026-10-17", periodStart: "2026-10-10", baseline: 100, latest: 40, baselineDays: 7, sample: 100, complete: true, mature: true, source: "ga4", scope: "one", runId: "source", direction: "lowlight" };
const policy: RegistrationPolicy = { sha: "policy", documentHash: "doc", data: { schedules: { timezone: "Asia/Seoul", registration: { localTimes: ["02:00", "14:00"], openAutopilotIssueLimit: 10, mode: "evidence-batch" } }, repositories: [{ repository: "seorilabs/example", registration: "ENABLED" }], titlePolicy: { forbiddenPrefixPatterns: [], forbiddenAgentOrderPattern: "[UN][0-9]+" } } };
function ports() {
  const attempts: string[] = [], results: string[] = [];
  let creates = 0, active = 0, maxActive = 0;
  const port: RegistrationPorts = {
    labelsExist: async () => true, now: () => new Date("2026-10-18T05:00:00Z"), active: async () => true, policy: async () => policy,
    readback: async () => ({ sha: "source", private: true, issues: [], pulls: [], openAutopilot: 0 }),
    files: async () => ({ "events.ts": 'send("action", {})', "contract.ts": 'required: ["id"]' }), relatedFix: async () => null,
    facts: async () => [fact], attempt: async (key) => { if (attempts.includes(key)) return false; attempts.push(key); return true; },
    result: async (row) => { results.push(row.status); },
    create: async (title, body, labels) => { creates++; active++; maxActive = Math.max(active, maxActive); await new Promise((r) => setTimeout(r, 5)); active--; return { number: creates, title, body, labels, state: "open", url: "https://github.com/seorilabs/example/issues/1" }; },
  };
  return { port, attempts, results, counts: () => ({ creates, maxActive }) };
}
test("고정 후보를 직렬 생성하고 같은 후보를 한 실행에서 다시 보내지 않는다", async () => {
  const p = ports(); await registerFixedCandidates("app", "seorilabs/example", "source", [candidate, candidate], p.port);
  assert.deepEqual(p.counts(), { creates: 1, maxActive: 1 }); assert.equal(p.attempts.length, 1);
});
test("생성 응답 유실 후 이슈 마커를 먼저 읽고 재전송하지 않는다", async () => {
  const p = ports(); let sent: { title: string; body: string; labels: string[] } | undefined;
  p.port.create = async (title, body, labels) => { sent = { title, body, labels }; throw new Error("timeout"); };
  p.port.readback = async () => ({ sha: "source", private: true, issues: sent ? [{ ...sent, number: 7, state: "open", url: "https://github.com/seorilabs/example/issues/7" }] : [], pulls: [], openAutopilot: sent ? 1 : 0 });
  assert.equal(await registerFixedCandidates("app", "seorilabs/example", "source", [candidate], p.port), "completed"); assert.deepEqual(p.results, ["registered"]); assert.equal(p.attempts.length, 1);
});
test("응답 유실 뒤 생성 여부가 불명확하면 전역 안전 중단한다", async () => {
  const p = ports(); p.port.create = async () => { throw new Error("timeout"); };
  assert.equal(await registerFixedCandidates("app", "seorilabs/example", "source", [candidate], p.port), "global-safety-blocked"); assert.deepEqual(p.results, ["needs_input"]);
});
test("매 생성 전에 정책·재고·기본 브랜치·표본·수정 관찰을 다시 확인한다", async () => {
  for (const reason of ["policy", "inventory", "sha", "sample", "fix", "lease"] as const) {
    const p = ports();
    if (reason === "policy") p.port.policy = async () => ({ ...policy, data: { ...policy.data, repositories: [] } });
    if (reason === "inventory") p.port.readback = async () => ({ sha: "source", private: true, issues: [], pulls: [], openAutopilot: 10 });
    if (reason === "sha") p.port.readback = async () => ({ sha: "changed", private: true, issues: [], pulls: [], openAutopilot: 0 });
    if (reason === "sample") p.port.facts = async () => [{ ...fact, sample: 1 }];
    if (reason === "fix") p.port.relatedFix = async () => new Date("2026-10-18T00:00:00Z");
    if (reason === "lease") p.port.active = async () => false;
    await registerFixedCandidates("app", "seorilabs/example", "source", [candidate], p.port); assert.equal(p.counts().creates, 0, reason);
  }
});
test("발췌·제목이 달라도 같은 파일과 선언 계약은 같은 문제로 연결한다", async () => {
  const p = ports(), changed = { ...candidate, title: "핵심 행동 인자를 전달한다", proof: { ...candidate.proof, excerpt: 'send("action", {})\n' } };
  p.port.files = async () => ({ "events.ts": 'send("action", {})\n', "contract.ts": 'required: ["id"]' });
  assert.equal(candidateMarker("seorilabs/example", changed), candidateMarker("seorilabs/example", candidate));
  await registerFixedCandidates("app", "seorilabs/example", "source", [candidate, changed], p.port);
  assert.equal(p.counts().creates, 1); assert.deepEqual(p.results, ["registered", "linked"]);
});
test("라벨 조회 중 예산이 끝나면 POST 권한을 발급하지 않는다", async () => {
  const p = ports(); let active = true;
  p.port.active = async () => active; p.port.labelsExist = async () => { active = false; return true; };
  assert.equal(await registerFixedCandidates("app", "seorilabs/example", "source", [candidate], p.port), "execution-budget-exhausted");
  assert.equal(p.attempts.length, 0); assert.equal(p.counts().creates, 0);
});
test("생성 POST의 명확한 거절은 기록하고 종료하며 일반 GET 오류는 불명 상태를 유지한다", async () => {
  const p = ports(); p.port.create = async () => { throw new IssuePostRejected(403); };
  assert.equal(await registerFixedCandidates("app", "seorilabs/example", "source", [candidate], p.port), "provider-rejected");
  assert.deepEqual(p.results, ["needs_input"]);
  const ambiguous = ports(); ambiguous.port.create = async () => { throw Object.assign(new Error("후속 GET 권한 오류"), { status: 403 }); };
  assert.equal(await registerFixedCandidates("app", "seorilabs/example", "source", [candidate], ambiguous.port), "global-safety-blocked");
});
