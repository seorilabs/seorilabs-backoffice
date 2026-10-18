import { prisma } from "@/lib/prisma";
import { metricDayOf, toDbDay } from "@/lib/analytics/metric-day";
import { loadRegistrationPolicy } from "./policy";
import { withRegistrationGithub } from "./github";
import { issueMetricFacts } from "./facts";
import { analyzeIssueCandidates } from "./analysis";
import { candidateGate } from "./contracts";
import { registerFixedCandidates } from "./engine";
import { recoverRegistrationAttempts } from "./recovery";
import { claimMetricRegistration, finishMetricRegistration, registrationActive, registrationAttempt, registrationEvent, registrationResult, type RegistrationClaim } from "./queue";

async function recover(claim: RegistrationClaim) {
  const events = await prisma.agentRunEvent.findMany({ where: { runId: claim.runId, type: { in: ["METRIC_ISSUE_ATTEMPT", "METRIC_ISSUE_RESULT"] } }, orderBy: { createdAt: "asc" } });
  return recoverRegistrationAttempts(events, {
    find: (intent) => withRegistrationGithub(intent.repository, (github) => github.findIssueForRecovery(intent.marker, new Date())),
    confirm: async (intent, row) => { await registrationEvent(claim, "METRIC_ISSUE_RESULT", { appId: intent.appId, repository: intent.repository, status: "registered", title: row.title, marker: intent.marker, url: row.url, number: row.number, reason: "실행 중단 후 생성 여부·본문·라벨을 다시 확인했습니다." }, `${claim.runId}:recovered:${intent.marker}`); },
  });
}
/** 기존 operator worker의 유지보수 호출이 중앙 슬롯을 한 번만 claim한다. 별도 등록 루프는 없다. */
export async function maintainMetricIssueRegistration() {
  if (process.env.FEATURE_METRIC_ISSUE_REGISTRATION !== "true") return;
  const policy = await loadRegistrationPolicy(), claim = await claimMetricRegistration(policy);
  if (!claim) return;
  const started = Date.now(), visited: string[] = [];
  let reason = "repository-pass-completed";
  try {
    if (claim.recovery) {
      reason = await recover(claim) ? "repository-pass-completed" : "global-safety-blocked";
      return;
    }
    const reportApps = await prisma.app.findMany({ where: { status: { in: ["ACTIVE", "PAUSED"] } }, select: { id: true, status: true, repoFullName: true } });
    for (const app of reportApps) if (app.status !== "ACTIVE" || !policy.data.repositories.some((row) => row.repository === app.repoFullName && row.registration === "ENABLED")) await registrationResult(claim, { appId: app.id, repository: app.repoFullName, status: "excluded", title: app.status === "PAUSED" ? "자동 운영이 중지된 앱은 새 이슈를 등록하지 않습니다." : "중앙 정책에 따라 자동 이슈 등록에서 제외합니다.", reason: "보고 대상에는 포함하며 추가 지표·코드 분석은 하지 않습니다.", policySha: policy.sha });
    const configured = policy.data.repositories.filter((row) => row.registration === "ENABLED").map((row) => row.repository);
    const today = metricDayOf(new Date()), dayIndex = Math.floor((toDbDay(today).getTime() - Date.UTC(Number(today.slice(0, 4)), 0, 1)) / 86400_000);
    const offset = configured.length ? dayIndex % configured.length : 0, repositories = [...configured.slice(offset), ...configured.slice(0, offset)];
    // 실행 입력에 순회와 예산을 고정한다. 이후 정책 재검사는 제외만 허용한다.
    await registrationEvent(claim, "METRIC_REGISTRATION_PLAN", { policySha: policy.sha, repositories, budget: claim.budget });
    const active = async () => Date.now() + 31_000 - started < claim.budget.maxElapsedMs && await registrationActive(claim);
    for (const repository of repositories) {
      if (!await active()) { reason = "execution-budget-exhausted"; break; }
      visited.push(repository);
      const app = await prisma.app.findFirst({ where: { repoFullName: repository, status: "ACTIVE" }, select: { id: true } });
      if (!app) { await registrationEvent(claim, "METRIC_REGISTRATION_SKIPPED", { repository, reason: "보고 대상 앱 연결 없음" }); continue; }
      const fresh = await loadRegistrationPolicy(true);
      if (!fresh.data.repositories.some((row) => row.repository === repository && row.registration === "ENABLED")) { await registrationResult(claim, { appId: app.id, repository, status: "excluded", title: "중앙 정책에서 등록을 제외했습니다.", reason: "현재 정책 제외", policySha: fresh.sha }); continue; }
      const stop = await withRegistrationGithub(repository, async (github) => {
        const state = await github.readback(new Date(), fresh.data.schedules.registration.openAutopilotIssueLimit);
        if (state.archived) { await registrationResult(claim, { appId: app.id, repository, status: "excluded", title: "보관된 저장소는 등록에서 제외합니다.", reason: "공급자 저장소 상태" }); return "completed"; }
        if (state.openAutopilot >= fresh.data.schedules.registration.openAutopilotIssueLimit) { await registrationResult(claim, { appId: app.id, repository, status: "observing", title: "기존 자동 처리 이슈의 해결을 기다립니다.", reason: "중앙 재고 상한", policySha: fresh.sha }); return "completed"; }
        const recentRelease = await prisma.releaseRecord.findFirst({ where: { appId: app.id, deployedAt: { gte: new Date(Date.now() - 7 * 86400_000) } } });
        if (recentRelease) { await registrationResult(claim, { appId: app.id, repository, status: "observing", title: "최근 배포 후 효과를 관찰합니다.", reason: "최근 배포 뒤 7일 관찰 기간" }); return "completed"; }
        const facts = (await issueMetricFacts(app.id, new Date())).filter((fact) => candidateGate({ enabled: true, open: state.openAutopilot, limit: fresh.data.schedules.registration.openAutopilotIssueLimit, relatedFixAt: null, now: new Date(), fact, kind: "defect" }) === "eligible");
        if (!facts.length) { await registrationResult(claim, { appId: app.id, repository, status: "insufficient", title: "등록할 근거를 갖춘 새 개선 후보가 없습니다.", reason: "완전한 비교·표본·분모 또는 분석 가능한 변화가 없음" }); return "completed"; }
        if (!await active()) return "execution-budget-exhausted";
        const readFiles = await github.files(state.sha), files: Record<string, string> = {};
        for (const [path, text] of Object.entries(readFiles).sort(([a], [b]) => Number(/^(AGENTS|README)\.md$/.test(a)) - Number(/^(AGENTS|README)\.md$/.test(b)))) if (Buffer.byteLength(JSON.stringify(files)) + Buffer.byteLength(text) < 28000) files[path] = text;
        const usagePath = `metric-issues:${claim.runId}`;
        const used = await prisma.aiUsage.aggregate({ where: { path: usagePath }, _sum: { totalTokens: true } });
        // UTF-8 바이트 수보다 token 수가 커지지 않는 입력만 허용하고 출력 한도를 선차감한다.
        const upperBound = Buffer.byteLength(JSON.stringify({ facts, files, issues: state.issues.map(({ number, title, state }) => ({ number, title, state })), pulls: state.pulls.map(({ number, title, closing }) => ({ number, title, closing })) })) + 6000;
        if ((used._sum.totalTokens ?? 0) + upperBound > claim.budget.maxTokens) return "execution-budget-exhausted";
        const candidates = await analyzeIssueCandidates(facts, files, state, usagePath);
        await registrationEvent(claim, "METRIC_ISSUE_CANDIDATES", { appId: app.id, repository, sourceSha: state.sha, candidates });
        if (!candidates.length) await registrationResult(claim, { appId: app.id, repository, status: "insufficient", title: "재현 가능한 코드 근거를 확인하지 못했습니다.", reason: "추가 분석 미구성·예산 부족·실패 또는 유효 후보 없음. 수치 악화만으로 원인을 단정하지 않습니다." });
        return registerFixedCandidates(app.id, repository, state.sha, candidates, {
          labelsExist: (labels) => github.labelsExist(labels), now: () => new Date(), active, policy: () => loadRegistrationPolicy(true), readback: () => github.readback(new Date()), files: (sha) => github.files(sha), relatedFix: (candidate, pulls, now) => github.relatedFix(candidate, pulls, now), facts: () => issueMetricFacts(app.id, new Date()),
          attempt: (marker, intent) => registrationAttempt(claim, marker, intent), result: (row) => registrationResult(claim, row), create: (title, body, labels) => github.create(title, body, labels),
        });
      });
      if (stop !== "completed") { reason = stop === "provider-rejected" ? "global-safety-blocked" : stop; break; }
    }
  } catch {
    reason = "global-safety-blocked";
    await registrationEvent(claim, "METRIC_REGISTRATION_ERROR", { reason: "정책·인증·자료의 완전성을 확인할 수 없어 등록을 중지했습니다." });
  } finally {
    await finishMetricRegistration(claim, reason, { visited, newIssues: await prisma.agentRunEvent.count({ where: { runId: claim.runId, type: "METRIC_ISSUE_RESULT", payload: { path: "$.status", equals: "registered" } } }) });
    const { correctDailyReport } = await import("@/lib/report/daily-publication");
    const { lastElapsedMetricDay } = await import("@/lib/analytics/metric-day");
    await correctDailyReport(new Date(), lastElapsedMetricDay(new Date())).catch(() => {});
  }
}
