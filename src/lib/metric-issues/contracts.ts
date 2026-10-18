import { z } from "zod";
import { containsCredentialCandidate } from "@/lib/control-plane/contracts";
import { metricDayOf, metricDayStart, shiftMetricDay } from "@/lib/analytics/metric-day";

const safeText = z.string().trim().min(1).max(1500).refine((value) => !containsCredentialCandidate(value) && !/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value), "비밀값·개인 연락처를 등록할 수 없습니다.");
const path = z.string().regex(/^[A-Za-z0-9_./-]{1,200}$/).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."));
export const candidateSchema = z.object({
  title: safeText.refine((value) => value.length <= 110 && !/^\s*(\[|P[1-4]\s*[:\-]|seorilabs\/)/.test(value) && !/(^|[^A-Za-z0-9])[UN][0-9]+([^A-Za-z0-9]|$)/.test(value)),
  kind: z.enum(["defect", "instrumentation"]), priority: z.enum(["P1", "P2", "P3", "P4"]),
  problemKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{3,100}$/),
  customerProblem: safeText, outcome: safeText, scope: z.array(path).min(1).max(5),
  acceptanceCriteria: z.array(safeText).min(2).max(5), validation: z.array(safeText).min(1).max(4),
  proof: z.object({ path, line: z.number().int().positive(), excerpt: safeText, contractPath: path, contractExcerpt: safeText, expected: safeText, actual: safeText, reproduction: safeText }).strict(),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export interface MetricFact { metric: string; day: string; periodStart: string; baseline: number; latest: number; baselineDays: number; sample: number; complete: boolean; mature: boolean; source: string; scope: string; runId: string; direction: "lowlight" | "highlight" }
export interface RegistrationPolicy { sha: string; documentHash: string; data: { schedules: { timezone: string; registration: { localTimes: string[]; openAutopilotIssueLimit: number; mode: string } }; repositories: Array<{ repository: string; registration: string }>; titlePolicy: { forbiddenPrefixPatterns: string[]; forbiddenAgentOrderPattern: string } } }
export function registrationSlot(now: Date, times: string[]): Date {
  const today = metricDayOf(now), start = metricDayStart(today).getTime();
  const slots = times.map((time) => { const [hour, minute] = time.split(":").map(Number); return new Date(start + (hour * 60 + minute) * 60_000); }).filter((date) => date <= now).sort((a, b) => b.getTime() - a.getTime());
  if (slots.length) return slots[0];
  return registrationSlot(new Date(metricDayStart(today).getTime() - 1), times);
}
export function candidateGate(input: { enabled: boolean; open: number; limit: number; relatedFixAt: Date | null; now: Date; fact: MetricFact; kind: Candidate["kind"] }) {
  if (!input.enabled) return "excluded";
  if (input.open >= input.limit) return "backpressure";
  const fact = input.fact;
  if (!fact.mature || input.relatedFixAt && input.now.getTime() - input.relatedFixAt.getTime() < 7 * 86400_000) return "observing";
  if (!fact.complete || fact.baselineDays < 4 || fact.sample < 5 || fact.baseline <= 0 || /revenue|sales|proceeds|cost|iap|iaa|ecpm/.test(fact.metric)) return "insufficient";
  if (fact.direction !== "lowlight") return "insufficient";
  if (fact.day < shiftMetricDay(metricDayOf(input.now), -7)) return "observing";
  return "eligible";
}
export function verifyCodeProof(candidate: Candidate, files: Record<string, string>) {
  const actual = files[candidate.proof.path], contract = files[candidate.proof.contractPath];
  if (!actual || !contract || !candidate.scope.includes(candidate.proof.path) || candidate.scope.some((path) => !files[path])) return false;
  return actual.split("\n").slice(candidate.proof.line - 1).join("\n").startsWith(candidate.proof.excerpt) && contract.includes(candidate.proof.contractExcerpt);
}
export function metricIssueTitle(candidate: Candidate, publicRepository: boolean) {
  if (!publicRepository) return candidate.title;
  const name = candidate.proof.path.split("/").at(-1)!.slice(0, 60);
  return candidate.kind === "instrumentation" ? `${name}의 이벤트 계약을 맞춰 핵심 행동을 기록한다` : `${name}의 선언과 실행 경로를 맞춰 기능 오류를 막는다`;
}
export function renderMetricIssue(candidate: Candidate, fact: MetricFact, input: { repo: string; sha: string; marker: string; publicRepository: boolean }) {
  const code = `https://github.com/${input.repo}/blob/${input.sha}/${candidate.proof.path}#L${candidate.proof.line}`;
  // 공개 저장소에는 모델 자유 서술·운영 수치 대신 확인된 공개 코드와 고정 안내만 사용한다.
  if (input.publicRepository) return ["## 고객 가치", "공개된 선언 계약과 실행 경로를 맞춰 해당 기능을 안정적으로 검증하고 이용자가 기능 상태를 정확히 이해하도록 합니다.", "## 문제와 근거", `선언: https://github.com/${input.repo}/blob/${input.sha}/${candidate.proof.contractPath}`, candidate.proof.contractExcerpt.split("\n").map((line) => `    ${line}`).join("\n"), `실행 경로: ${code}`, candidate.proof.excerpt.split("\n").map((line) => `    ${line}`).join("\n"), "운영 표본·기간·기준선·수집 범위는 권한이 필요한 백오피스 근거에 보존합니다. 이 코드만으로 라이브 피해 규모를 단정하지 않습니다.", "## 해결 후 기대 상태", "선언 계약과 실제 실행 경로가 일치합니다.", "## 범위", candidate.scope.map((path) => `- ${path}`).join("\n"), "## 인수조건", "- [ ] 명시된 계약을 실제 처리·전송 경로에서 충족한다\n- [ ] 중복 처리 없이 관련 기능의 기존 동작을 보존한다", "## 검증 방법", "대상 코드 경로를 개발 환경에서 실행하고 해당 계약을 검증하는 테스트를 추가합니다.", "## 실행 환경", "분류: autopilot:cloud. 로컬 전용 의존성 없음. 대상 저장소의 공개 코드와 CI·개발 환경 테스트로 선언 계약을 검증합니다. 비공개 운영 수치의 재조회는 인수조건이 아닙니다. 구현은 별도 승인 설계와 테스트 계획을 따르며 기기·배포·계정 변경 승인을 포함하지 않습니다.", `<!-- ${input.marker} -->`].join("\n\n");
  return [
    "## 고객 가치", candidate.customerProblem,
    "## 문제와 근거", `- 코드 계약: ${candidate.proof.expected}\n- 실제 경로: ${candidate.proof.actual}\n- 재현: ${candidate.proof.reproduction}\n- exact source: ${code}`,
    `기간 ${fact.periodStart}~${fact.day} · ${fact.source} · ${fact.scope}\n기준선 ${fact.baseline} (유효 ${fact.baselineDays}일), 최신 ${fact.latest}, 표본 ${fact.sample}, 수집 완전 ${fact.complete}, 성숙 ${fact.mature} · 실행 ${fact.runId}`,
    "수치 변화는 이 코드 경로의 인과 증거가 아닙니다. 선언 계약과 실제 코드의 재현을 독립 근거로 사용합니다.",
    "## 해결 후 기대 상태", candidate.outcome,
    "## 범위", candidate.scope.map((value) => `- ${value}`).join("\n"), "앱 코드 변경·릴리스 실행은 별도 승인된 설계와 테스트 계획을 따릅니다.",
    "## 인수조건", candidate.acceptanceCriteria.map((value) => `- [ ] ${value}`).join("\n"),
    "## 검증 방법", candidate.validation.map((value) => `- ${value}`).join("\n"),
    "## 실행 환경", "개발 환경과 해당 저장소 테스트. 비공개 운영 근거 확인에는 등록된 읽기 identity가 필요하므로 autopilot:local을 사용합니다. 기기·마켓·프로덕션 변경 승인을 포함하지 않습니다.",
    `<!-- ${input.marker} -->`,
  ].join("\n\n");
}
