import { createHash } from "node:crypto";
import { candidateGate, metricIssueTitle, renderMetricIssue, verifyCodeProof, type Candidate, type MetricFact, type RegistrationPolicy } from "./contracts";
import type { IssueReadback, PullReadback, RepositoryReadback } from "./github";
export interface RegistrationResult { appId: string; repository: string; status: "registered" | "linked" | "insufficient" | "observing" | "excluded" | "needs_input"; title: string; reason: string; marker?: string; url?: string; number?: number; policySha?: string; sourceSha?: string; fact?: MetricFact }
export interface RegistrationPorts {
  now(): Date; active(): Promise<boolean>; policy(): Promise<RegistrationPolicy>; readback(): Promise<RepositoryReadback>;
  files(sha: string): Promise<Record<string, string>>; relatedFix(candidate: Candidate, pulls: PullReadback[], now: Date): Promise<Date | null>;
  facts(): Promise<MetricFact[]>;
  attempt(marker: string, intent: { title: string; body: string; labels: string[]; appId: string; repository: string }): Promise<boolean>;
  labelsExist(labels: string[]): Promise<boolean>;
  result(result: RegistrationResult): Promise<void>; create(title: string, body: string, labels: string[]): Promise<IssueReadback>;
}
export function candidateMarker(repository: string, candidate: Candidate) {
  return `metric-issue:${createHash("sha256").update(JSON.stringify([repository, candidate.kind, candidate.proof.path, candidate.proof.excerpt, candidate.proof.contractPath, candidate.proof.contractExcerpt])).digest("hex")}`;
}
function duplicate(candidate: Candidate, marker: string, title: string, state: RepositoryReadback) {
  const normalized = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return state.issues.find((row) => row.body.includes(marker) || normalized(row.title) === normalized(title) || row.body.includes(candidate.proof.excerpt) && row.body.includes(candidate.proof.path));
}
function confirms(row: IssueReadback, title: string, body: string, labels: string[]) {
  return row.title === title && row.body === body && labels.every((label) => row.labels.includes(label));
}
/** 호출자가 사전에 봉인한 유한 목록만 직렬로 소진한다. 응답 불명은 새 POST 없이 readback한다. */
export async function registerFixedCandidates(appId: string, repository: string, sourceSha: string, candidates: Candidate[], port: RegistrationPorts): Promise<"completed" | "execution-budget-exhausted" | "global-safety-blocked"> {
  for (const candidate of candidates) {
    if (!await port.active()) return "execution-budget-exhausted";
    const policy = await port.policy();
    const base = { appId, repository, title: candidate.title, policySha: policy.sha, sourceSha };
    if (!policy.data.repositories.some((row) => row.repository === repository && row.registration === "ENABLED")) { await port.result({ ...base, status: "excluded", reason: "중앙 정책에서 등록을 허용하지 않습니다." }); continue; }
    const state = await port.readback(), title = metricIssueTitle(candidate, !state.private), marker = candidateMarker(repository, candidate);
    if (state.archived) { await port.result({ ...base, status: "excluded", reason: "보관되었거나 사용할 수 없는 저장소입니다." }); continue; }
    if (state.openAutopilot >= policy.data.schedules.registration.openAutopilotIssueLimit) { await port.result({ ...base, status: "observing", reason: "열린 자동 처리 이슈가 중앙 재고 상한에 도달했습니다." }); continue; }
    const existing = duplicate(candidate, marker, title, state);
    if (existing) { await port.result({ ...base, title, marker, status: "linked", reason: "열린·최근 종료 이슈 또는 관련 PR의 기존 문제와 연결했습니다.", url: existing.url, number: existing.number }); continue; }
    const fact = (await port.facts()).find((row) => candidateGate({ enabled: true, open: state.openAutopilot, limit: policy.data.schedules.registration.openAutopilotIssueLimit, relatedFixAt: null, now: port.now(), fact: row, kind: candidate.kind }) === "eligible");
    if (!fact) { await port.result({ ...base, status: "insufficient", reason: "완전한 비교·표본을 갖춘 변화 근거가 없습니다." }); continue; }
    const gate = candidateGate({ enabled: true, open: state.openAutopilot, limit: policy.data.schedules.registration.openAutopilotIssueLimit, relatedFixAt: await port.relatedFix(candidate, state.pulls, port.now()), now: port.now(), fact, kind: candidate.kind });
    if (gate !== "eligible" || state.sha !== sourceSha) { await port.result({ ...base, status: "observing", reason: gate === "backpressure" ? "열린 자동 처리 이슈가 중앙 재고 상한에 도달했습니다." : "최근 수정 또는 기본 브랜치 변경 뒤 다시 관찰해야 합니다.", fact }); continue; }
    if (!verifyCodeProof(candidate, await port.files(state.sha))) { await port.result({ ...base, status: "insufficient", reason: "현재 코드에서 선언·실행 경로 근거를 다시 확인할 수 없습니다.", fact }); continue; }
    if (policy.data.titlePolicy.forbiddenPrefixPatterns.some((pattern) => new RegExp(pattern).test(title)) || new RegExp(policy.data.titlePolicy.forbiddenAgentOrderPattern).test(title)) { await port.result({ ...base, status: "insufficient", reason: "중앙 제목 계약을 충족하지 않습니다." }); continue; }
    const body = renderMetricIssue(candidate, fact, { repo: repository, sha: sourceSha, marker, publicRepository: !state.private });
    const labels = ["autopilot", "P3", state.private ? "autopilot:local" : "autopilot:cloud", candidate.kind === "instrumentation" ? "instrumentation" : "bug", fact.source === "ga4" ? "evidence:ga4" : fact.source === "console" ? "evidence:console" : "evidence:store"];
    if (!await port.labelsExist(labels)) { await port.result({ ...base, status: "needs_input", reason: "중앙 필수 라벨이 저장소에 없습니다. 표준 라벨 조정이 필요합니다." }); continue; }
    if (!await port.attempt(marker, { title, body, labels, appId, repository })) continue;
    let created: IssueReadback | undefined;
    try { created = await port.create(title, body, labels); } catch { /* POST는 재시도하지 않는다. */ }
    if (!created || !confirms(created, title, body, labels)) {
      try { created = (await port.readback()).issues.find((row) => row.body.includes(marker)); } catch { created = undefined; }
    }
    if (!created || !confirms(created, title, body, labels)) { await port.result({ ...base, title, marker, status: "needs_input", reason: "생성 여부 또는 본문·라벨 readback이 불명확합니다. 재전송 없이 등록 전체를 중지했습니다.", fact }); return "global-safety-blocked"; }
    await port.result({ ...base, title, marker, status: "registered", reason: "생성한 이슈의 번호·본문·라벨을 다시 확인했습니다.", url: created.url, number: created.number, fact });
  }
  return "completed";
}
