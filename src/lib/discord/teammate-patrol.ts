import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { geminiChat } from "@/lib/ai/gemini";
import { parseLooseJson } from "@/lib/ai/json";
import { getInstallationOctokit } from "@/lib/github/app";
import { createIssue } from "@/lib/github/write";
import {
  createDiscordChannelMessage,
  createDiscordChannelMessageAs,
  type DiscordActionRow,
} from "@/lib/notifications/discord";
import { visibleAppWhere, visibleIssueWhere } from "@/lib/domain/app-visibility";
import { hasApproval } from "@/lib/domain/labels";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import { asStringArray } from "@/lib/format";
import { TEAMMATES, type TeammateMeta, type TeammateRole } from "@/lib/discord/teammates";
import { withGemini429Retry } from "@/lib/discord/teammate-chat";
import { collectFinanceCosts } from "@/lib/discord/teammate-costs";
import {
  buildIssueBody,
  extractTeammateMarkers,
  parsePatrolFindings,
  registrationDecision,
  renderPatrolReport,
  selectDraftIndexes,
  type PatrolFinding,
} from "@/lib/discord/teammate-findings";

// 순찰 실행 경로(DB·GitHub·Discord·Gemini). 근거 게이트는 코드로 강제한다:
// collector 가 DB 에서 evidence 행을 먼저 수집하고, Gemini 는 주어진 evidence 에
// 대한 문장만 쓴다. evidence 없는 항목은 초안이 될 수 없고, 등록 전에
// open+closed GitHub 이슈와 marker 로 교차 dedupe 한다.

const DAY_MS = 24 * 3_600_000;
const MAX_FINDINGS_PER_RUN = 8;
const DEDUPE_WINDOW_DAYS = 90;
const STAGE_STALL_DAYS = 14;
const APPROVAL_WAIT_DAYS = 3;
const P1_STALE_DAYS = 2;
const GA4_GAP_DAYS = 2; // GA4 일별 export 는 하루 지연까지 정상
const CONSOLE_GAP_DAYS = 4; // 콘솔 지표는 온디맨드 push 라 더 느슨하게
const DAU_DROP_RATIO = 0.5;
const DAU_MIN_BASE = 10;
const INCIDENT_AGE_HOURS = 24;
const RELEASE_STUCK_HOURS = 24;
const SUBMISSION_STUCK_DAYS = 3;
const REVIEW_CLUSTER_DAYS = 7;
const REVIEW_CLUSTER_MIN = 3;
const PATROL_STALE_MS = 30 * 60_000;
const PATROL_PENDING_EXPIRE_MS = 24 * 60 * 60_000;
// worker 재기동으로 끊긴 멘션의 재시도 창. 5분 넘게 PROCESSING 이면 끊긴 것으로
// 보고(정상 응답은 수십 초), 생성 60분이 지난 질문에는 뒤늦게 답하지 않는다.
const MENTION_RETRY_AFTER_MS = 5 * 60_000;
const MENTION_RETRY_WINDOW_MS = 60 * 60_000;
const MENTION_MAX_ATTEMPTS = 2;

function ageDays(from: Date, now: Date): number {
  return Math.floor((now.getTime() - from.getTime()) / DAY_MS);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function finding(input: Omit<PatrolFinding, "status">): PatrolFinding {
  return { ...input, status: "skipped" };
}

// ── 팀원별 collector — 전부 pod 내 DB 근거 ──────────────────────────────────

async function collectProduct(now: Date): Promise<PatrolFinding[]> {
  const findings: PatrolFinding[] = [];
  const apps = await prisma.app.findMany({
    where: { ...visibleAppWhere, currentStage: { not: "LIVEOPS" } },
    select: {
      slug: true,
      displayName: true,
      repoFullName: true,
      currentStage: true,
      transitions: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
    },
  });
  for (const app of apps) {
    const since = app.transitions[0]?.createdAt;
    if (!since) continue;
    const days = ageDays(since, now);
    if (days < STAGE_STALL_DAYS) continue;
    const stage = STAGE_KO[app.currentStage] ?? app.currentStage;
    findings.push(finding({
      key: `stage-stall:${app.slug}`,
      title: `${app.displayName} ${stage} 단계 ${days}일 정체`,
      detail: `${app.displayName} 이 ${stage} 단계에서 ${days}일째 다음 단계로 전이되지 않고 있다.`,
      repoFullName: app.repoFullName,
      labels: ["P3"],
      evidence: [`마지막 단계 전이 ${since.toISOString().slice(0, 10)} (${days}일 전), 현재 단계 ${stage}`],
    }));
  }

  const openIssues = await prisma.issueMirror.findMany({
    where: { ...visibleIssueWhere, state: "OPEN" },
    select: { repoFullName: true, number: true, title: true, labels: true, priority: true, ghUpdatedAt: true },
    orderBy: { ghUpdatedAt: "asc" },
    take: 300,
  });
  for (const issue of openIssues) {
    const labels = asStringArray(issue.labels);
    const waiting = hasApproval(labels, "planning") || hasApproval(labels, "release");
    const days = ageDays(issue.ghUpdatedAt, now);
    if (waiting && days >= APPROVAL_WAIT_DAYS) {
      findings.push(finding({
        key: `approval-wait:${issue.repoFullName}#${issue.number}`,
        title: `승인 대기 ${days}일: ${issue.repoFullName}#${issue.number}`,
        detail: `${issue.repoFullName}#${issue.number} 이 승인 게이트에서 ${days}일째 멈춰 있다.`,
        repoFullName: null, // 승인은 이슈 등록이 아니라 사람 판단 대상
        labels: [],
        evidence: [`${issue.title.slice(0, 80)} · 마지막 갱신 ${issue.ghUpdatedAt.toISOString().slice(0, 10)}`],
      }));
    } else if (issue.priority === "P1" && days >= P1_STALE_DAYS) {
      findings.push(finding({
        key: `p1-stale:${issue.repoFullName}#${issue.number}`,
        title: `P1 ${days}일 미갱신: ${issue.repoFullName}#${issue.number}`,
        detail: `열린 P1 이슈 ${issue.repoFullName}#${issue.number} 이 ${days}일째 갱신이 없다.`,
        repoFullName: null, // 이미 이슈가 있으므로 새 이슈를 만들지 않는다
        labels: [],
        evidence: [`${issue.title.slice(0, 80)} · 마지막 갱신 ${issue.ghUpdatedAt.toISOString().slice(0, 10)}`],
      }));
    }
  }
  return findings;
}

async function collectDataTeam(now: Date): Promise<PatrolFinding[]> {
  const findings: PatrolFinding[] = [];
  const ga4Apps = await prisma.app.findMany({
    where: { ...visibleAppWhere, ga4Dataset: { not: null } },
    select: {
      slug: true,
      displayName: true,
      repoFullName: true,
      metrics: { orderBy: { date: "desc" }, take: 8, select: { date: true, dau: true } },
    },
  });
  for (const app of ga4Apps) {
    const latest = app.metrics[0];
    if (!latest) continue; // 수집이 시작되지 않은 앱은 IAM/등록 문제라 별도 트랙
    const gap = ageDays(latest.date, now);
    if (gap > GA4_GAP_DAYS) {
      findings.push(finding({
        key: `export-gap:${app.slug}`,
        title: `${app.displayName} GA4 지표 ${gap}일째 공백`,
        detail: `${app.displayName} 의 GA4 일별 지표가 ${latest.date.toISOString().slice(0, 10)} 이후 수집되지 않고 있다. export 중단 또는 수집 SA 권한 문제일 수 있다.`,
        repoFullName: app.repoFullName,
        labels: ["P2"],
        evidence: [`마지막 지표일 ${latest.date.toISOString().slice(0, 10)} (${gap}일 전)`],
      }));
      continue;
    }
    const prior = app.metrics.slice(1).map((row) => row.dau);
    if (prior.length >= 4) {
      const base = median(prior);
      if (base >= DAU_MIN_BASE && latest.dau < base * DAU_DROP_RATIO) {
        findings.push(finding({
          key: `dau-drop:${app.slug}`,
          title: `${app.displayName} DAU 급락 (${latest.dau} vs 중앙값 ${base})`,
          detail: `${app.displayName} 의 최신 DAU ${latest.dau} 가 직전 7일 중앙값 ${base} 의 절반 아래다.`,
          repoFullName: app.repoFullName,
          labels: ["P2"],
          evidence: [
            `${latest.date.toISOString().slice(0, 10)} DAU ${latest.dau}`,
            `직전 ${prior.length}일 DAU 중앙값 ${base}`,
          ],
        }));
      }
    }
  }

  const consoleApps = await prisma.app.findMany({
    where: { ...visibleAppWhere, aitMiniAppId: { not: null } },
    select: {
      slug: true,
      displayName: true,
      consoleMetrics: { orderBy: { date: "desc" }, take: 1, select: { date: true } },
    },
  });
  for (const app of consoleApps) {
    const latest = app.consoleMetrics[0];
    if (!latest) continue;
    const gap = ageDays(latest.date, now);
    if (gap > CONSOLE_GAP_DAYS) {
      findings.push(finding({
        key: `console-gap:${app.slug}`,
        title: `${app.displayName} 콘솔 지표 ${gap}일째 공백`,
        detail: `${app.displayName} 의 AppsInToss 콘솔 지표가 ${latest.date.toISOString().slice(0, 10)} 이후 동기화되지 않았다. console-sync 실행이 필요하다.`,
        repoFullName: null, // 지표 동기화는 레포 작업이 아니라 운영 액션
        labels: [],
        evidence: [`마지막 콘솔 지표일 ${latest.date.toISOString().slice(0, 10)} (${gap}일 전)`],
      }));
    }
  }
  return findings;
}

async function collectDevelopment(now: Date): Promise<PatrolFinding[]> {
  const findings: PatrolFinding[] = [];
  const incidents = await prisma.operationalIncident.findMany({
    where: { status: "OPEN", firstDetectedAt: { lt: new Date(now.getTime() - INCIDENT_AGE_HOURS * 3_600_000) } },
    select: {
      dedupeKey: true,
      kind: true,
      severity: true,
      summary: true,
      firstDetectedAt: true,
      app: { select: { displayName: true, repoFullName: true } },
    },
    orderBy: { firstDetectedAt: "asc" },
    take: 10,
  });
  for (const incident of incidents) {
    const hours = Math.floor((now.getTime() - incident.firstDetectedAt.getTime()) / 3_600_000);
    findings.push(finding({
      key: `incident:${incident.dedupeKey}`,
      title: `${incident.app?.displayName ?? incident.kind} 장애 ${hours}시간 미해소`,
      detail: `${incident.summary.slice(0, 200)} — ${hours}시간째 OPEN 상태다.`,
      repoFullName: incident.app?.repoFullName ?? null,
      labels: ["P2"],
      evidence: [`장애 ${incident.kind} · 심각도 ${incident.severity} · 최초 감지 ${incident.firstDetectedAt.toISOString()}`],
    }));
  }

  const failedRuns = await prisma.workflowRunMirror.findMany({
    where: { conclusion: "failure", ghUpdatedAt: { gt: new Date(now.getTime() - DAY_MS) } },
    select: { repoFullName: true, runId: true, name: true, headBranch: true, ghUpdatedAt: true },
    orderBy: { ghUpdatedAt: "desc" },
    take: 50,
  });
  for (const run of failedRuns) {
    if (!/deploy/i.test(run.name ?? "")) continue;
    findings.push(finding({
      key: `deploy-fail:${run.repoFullName}:${run.runId}`,
      title: `${run.repoFullName} 배포 워크플로 실패`,
      detail: `${run.repoFullName} 의 "${run.name}" 실행이 실패로 끝났다 (${run.headBranch ?? "ref 불명"}).`,
      repoFullName: run.repoFullName,
      labels: ["P2"],
      evidence: [`workflow run ${run.runId} · ${run.ghUpdatedAt.toISOString()} · https://github.com/${run.repoFullName}/actions/runs/${run.runId}`],
    }));
  }

  const stuckReleases = await prisma.releaseRecord.findMany({
    where: { status: "IN_PROGRESS", updatedAt: { lt: new Date(now.getTime() - RELEASE_STUCK_HOURS * 3_600_000) } },
    select: { id: true, version: true, market: true, updatedAt: true, app: { select: { displayName: true, repoFullName: true } } },
    take: 10,
  });
  for (const release of stuckReleases) {
    const hours = Math.floor((now.getTime() - release.updatedAt.getTime()) / 3_600_000);
    findings.push(finding({
      key: `release-stuck:${release.id}`,
      title: `${release.app.displayName} ${release.version} ${release.market} 배포 ${hours}시간 정체`,
      detail: `${release.app.displayName} ${release.version} 의 ${release.market} 배포가 IN_PROGRESS 상태로 ${hours}시간째 멈춰 있다.`,
      repoFullName: release.app.repoFullName,
      labels: ["P2"],
      evidence: [`release record ${release.id} · 마지막 갱신 ${release.updatedAt.toISOString()}`],
    }));
  }
  return findings;
}

async function collectQa(now: Date): Promise<PatrolFinding[]> {
  const findings: PatrolFinding[] = [];
  const reviews = await prisma.storeReviewObservation.findMany({
    where: { rating: { lte: 2 }, lastObservedAt: { gt: new Date(now.getTime() - REVIEW_CLUSTER_DAYS * DAY_MS) } },
    select: { store: true, rating: true, app: { select: { slug: true, displayName: true, repoFullName: true } } },
  });
  const clusters = new Map<string, { count: number; ratings: number[]; app: (typeof reviews)[number]["app"]; store: string }>();
  for (const review of reviews) {
    const clusterKey = `${review.app.slug}:${review.store}`;
    const cluster = clusters.get(clusterKey) ?? { count: 0, ratings: [], app: review.app, store: review.store };
    cluster.count += 1;
    cluster.ratings.push(review.rating);
    clusters.set(clusterKey, cluster);
  }
  for (const [clusterKey, cluster] of clusters) {
    if (cluster.count < REVIEW_CLUSTER_MIN) continue;
    findings.push(finding({
      key: `review-cluster:${clusterKey}`,
      title: `${cluster.app.displayName} ${cluster.store} 저평점 리뷰 ${cluster.count}건 군집`,
      detail: `${cluster.app.displayName} 에 최근 ${REVIEW_CLUSTER_DAYS}일간 별점 2 이하 리뷰가 ${cluster.count}건 쌓였다 (${cluster.store}).`,
      repoFullName: cluster.app.repoFullName,
      labels: ["P2"],
      evidence: [`최근 ${REVIEW_CLUSTER_DAYS}일 rating<=2 리뷰 ${cluster.count}건, 평점 분포 ${cluster.ratings.join(",")}`],
    }));
  }

  const pendingReleases = await prisma.releaseRecord.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - SUBMISSION_STUCK_DAYS * DAY_MS) } },
    select: { id: true, version: true, market: true, createdAt: true, app: { select: { displayName: true, repoFullName: true } } },
    take: 10,
  });
  for (const release of pendingReleases) {
    const days = ageDays(release.createdAt, now);
    findings.push(finding({
      key: `submission-stuck:${release.id}`,
      title: `${release.app.displayName} ${release.version} ${release.market} ${days}일째 대기`,
      detail: `${release.app.displayName} ${release.version} 의 ${release.market} 배포 레코드가 생성 후 ${days}일째 PENDING 이다. 심사 제출이나 배포 트리거가 누락됐을 수 있다.`,
      repoFullName: release.app.repoFullName,
      labels: ["P3"],
      evidence: [`release record ${release.id} · 생성 ${release.createdAt.toISOString().slice(0, 10)} · 상태 PENDING`],
    }));
  }
  return findings;
}

interface CollectResult {
  findings: PatrolFinding[];
  // 발견과 무관하게 리포트에 항상 싣는 현황 스냅샷(파이낸스 전용, 다른 팀원은 빈 배열).
  summaryLines: string[];
}

async function collect(role: TeammateRole, now: Date): Promise<CollectResult> {
  if (role === "finance") {
    const result = await collectFinanceCosts(now);
    return {
      findings: result.findings.filter((item) => item.evidence.length > 0).slice(0, MAX_FINDINGS_PER_RUN),
      summaryLines: result.summaryLines,
    };
  }
  const collected =
    role === "product" ? await collectProduct(now)
    : role === "data" ? await collectDataTeam(now)
    : role === "development" ? await collectDevelopment(now)
    : await collectQa(now);
  // 근거 게이트: evidence 없는 항목은 어떤 경로로도 초안이 될 수 없다.
  return {
    findings: collected.filter((item) => item.evidence.length > 0).slice(0, MAX_FINDINGS_PER_RUN),
    summaryLines: [],
  };
}

// ── GitHub open+closed dedupe ───────────────────────────────────────────────

async function fetchExistingMarkers(repos: string[], since: Date): Promise<Map<string, string>> {
  const octokit = await getInstallationOctokit();
  const found = new Map<string, string>();
  for (const repoFullName of repos) {
    const [owner, repo] = repoFullName.split("/");
    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: "all",
      since: since.toISOString(),
      per_page: 100,
    });
    for (const issue of issues) {
      if (issue.pull_request) continue;
      for (const marker of extractTeammateMarkers(issue.body ?? "")) {
        if (!found.has(marker)) found.set(marker, issue.html_url);
      }
    }
  }
  return found;
}

// ── Gemini 종합(1회) — 주어진 evidence 에 대한 문장만 생성 ─────────────────

interface PatrolNarrative {
  report: string;
  suggestions: Map<string, string>;
}

async function synthesize(meta: TeammateMeta, findings: PatrolFinding[]): Promise<PatrolNarrative> {
  const payload = findings.map((item) => ({ key: item.key, title: item.title, evidence: item.evidence }));
  const raw = await withGemini429Retry(() =>
    geminiChat(
      [
        {
          role: "system",
          content: [
            `당신은 Seorilabs AI 팀원 "${meta.ko}"다. 아래 순찰 발견 목록(JSON)에 대해서만 서술한다.`,
            "목록에 없는 사실을 만들지 않는다. 출력은 JSON 객체 하나:",
            '{"report":"발견 전반의 2~3문장 한국어 요약","suggestions":{"<key>":"해당 발견의 1~2문장 대응 제안"}}',
          ].join("\n"),
        },
        { role: "user", content: JSON.stringify(payload) },
      ],
      { jsonOutput: true, maxTokens: 1_500, usage: { path: "patrol", teammate: meta.role } },
    ),
  );
  const parsed = parseLooseJson<{ report?: unknown; suggestions?: Record<string, unknown> }>(raw);
  const suggestions = new Map<string, string>();
  const validKeys = new Set(findings.map((item) => item.key));
  for (const [key, value] of Object.entries(parsed?.suggestions ?? {})) {
    // 목록에 없는 key 의 제안은 버린다 — 근거 없는 초안 유입을 막는 두 번째 게이트.
    if (validKeys.has(key) && typeof value === "string" && value.trim()) {
      suggestions.set(key, value.trim().slice(0, 500));
    }
  }
  return {
    report: typeof parsed?.report === "string" ? parsed.report.trim().slice(0, 1_000) : "",
    suggestions,
  };
}

function draftCardRows(runId: string, findingIndex: number): DiscordActionRow[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "이슈 등록", custom_id: `teammate:confirm:${runId}:${findingIndex}` },
      { type: 2, style: 2, label: "폐기", custom_id: `teammate:cancel:${runId}:${findingIndex}` },
    ],
  }];
}

// ── 순찰 실행(teammate worker 가 호출) ─────────────────────────────────────

async function executePatrol(
  run: { id: string; teammate: string },
  withGeminiSlot: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const meta = TEAMMATES[run.teammate as TeammateRole];
  if (!meta) throw new Error(`알 수 없는 팀원: ${run.teammate}`);
  const botToken = env.discordTeammateBotToken(meta.role);
  if (!botToken) throw new Error(`${meta.role} 팀원 자격증명이 설정되지 않았습니다.`);
  const channelId = env.discordChannelId(meta.channelKey);
  if (!channelId) throw new Error(`${meta.channelKey} 채널 ID 가 설정되지 않았습니다.`);

  const now = new Date();
  const { findings, summaryLines } = await collect(meta.role, now);

  // open+closed 이슈 교차 dedupe — 닫힌 이슈의 재발견도 marker 로 걸러진다.
  // 초안을 만들지 않는 팀원(finance)은 대상 repo 자체가 없어 자연히 건너뛴다.
  const repos = [...new Set(findings.map((item) => item.repoFullName).filter((repo): repo is string => Boolean(repo)))];
  if (repos.length > 0) {
    const existing = await fetchExistingMarkers(repos, new Date(now.getTime() - DEDUPE_WINDOW_DAYS * DAY_MS));
    for (const item of findings) {
      const url = existing.get(`${meta.role}:${item.key}`);
      if (url) {
        item.status = "deduped";
        item.issueUrl = url;
      }
    }
  }

  const draftIndexes = meta.draftsEnabled ? selectDraftIndexes(findings) : [];
  for (const index of draftIndexes) findings[index].status = "drafted";

  let narrative = "";
  // 파이낸스 리포트는 결정적 수치라 Gemini 서술을 쓰지 않는다(쿼타 보호).
  if (meta.draftsEnabled && findings.length > 0 && env.geminiChatConfigured()) {
    try {
      const synthesis = await withGeminiSlot(() => synthesize(meta, findings));
      narrative = synthesis.report;
      for (const item of findings) {
        const suggestion = synthesis.suggestions.get(item.key);
        if (suggestion) item.suggestion = suggestion;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // 429 재실패는 run FAILED 로 남겨 다음날 재시도한다. 그 외(파싱 등)는
      // 서술 없이 결정적 리포트로 계속 간다.
      if (message.includes("(429)")) throw error;
      console.error(`[teammate-patrol:${meta.role}] Gemini 종합 실패:`, message || "error");
    }
  }

  const report = renderPatrolReport(meta, findings, narrative, summaryLines);
  const posted = await createDiscordChannelMessageAs(botToken, channelId, report);
  if (!posted.ok) throw new Error(`순찰 보고 게시 실패: ${posted.error ?? "unknown"}`);

  // 초안 confirm 카드는 메인 봇 정체로 게시한다 — interaction 서명·처리 경로가
  // 기존 단일 앱 파이프라인에 그대로 남는다.
  for (const index of draftIndexes) {
    const item = findings[index];
    const card = [
      `📋 **이슈 초안 · ${meta.ko}** → ${item.repoFullName}`,
      `**${item.title}**`,
      item.detail,
      "",
      ...item.evidence.map((evidence) => `- ${evidence}`),
      ...(item.suggestion ? ["", `제안: ${item.suggestion}`] : []),
    ].join("\n");
    const created = await createDiscordChannelMessage(channelId, card, {
      components: draftCardRows(run.id, index),
    });
    if (!created.ok) console.error(`[teammate-patrol:${meta.role}] 초안 카드 게시 실패:`, created.error);
  }

  await prisma.teammateRun.update({
    where: { id: run.id },
    data: {
      status: "COMPLETED",
      findingCount: findings.length,
      findings: findings as unknown as Prisma.InputJsonValue,
      outcome: `발견 ${findings.length}건, 초안 ${draftIndexes.length}건, 중복 ${findings.filter((item) => item.status === "deduped").length}건`,
      completedAt: new Date(),
    },
  });
}

/** PENDING 순찰 run 을 하나 claim 해 실행한다. 처리했으면 true. */
export async function processNextTeammatePatrol(
  withGeminiSlot: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<boolean> {
  const candidate = await prisma.teammateRun.findFirst({
    where: { status: "PENDING", trigger: "schedule" },
    orderBy: { createdAt: "asc" },
    select: { id: true, teammate: true },
  });
  if (!candidate) return false;
  const claimed = await prisma.teammateRun.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING", attempts: { increment: 1 }, startedAt: new Date() },
  });
  if (claimed.count !== 1) return true;
  try {
    await executePatrol(candidate, withGeminiSlot);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "순찰 실패";
    console.error(`[teammate-patrol:${candidate.teammate}] 실패:`, message);
    await prisma.teammateRun.update({
      where: { id: candidate.id },
      data: { status: "FAILED", outcome: message, completedAt: new Date() },
    });
  }
  return true;
}

/** 워커 중단으로 남은 PROCESSING, 소화되지 못한 PENDING 을 정리한다. */
export async function maintainTeammateRuns(now = new Date()) {
  const [mentionRetry, mentionExpired, stale, expired] = await prisma.$transaction([
    // 1) 끊긴 최근 멘션은 FAILED 대신 PENDING 으로 되돌려 worker 가 재시도한다.
    //    payload 없는 구형 행과 시도 소진 행은 아래 stale 규칙(30분 FAILED)에 맡긴다.
    prisma.teammateRun.updateMany({
      where: {
        status: "PROCESSING",
        trigger: "mention",
        startedAt: { lt: new Date(now.getTime() - MENTION_RETRY_AFTER_MS) },
        createdAt: { gt: new Date(now.getTime() - MENTION_RETRY_WINDOW_MS) },
        attempts: { lt: MENTION_MAX_ATTEMPTS },
        payload: { not: Prisma.AnyNull },
      },
      data: { status: "PENDING" },
    }),
    // 2) 재시도조차 소화되지 못한 멘션 PENDING 은 60분에 만료한다.
    prisma.teammateRun.updateMany({
      where: {
        status: "PENDING",
        trigger: "mention",
        createdAt: { lt: new Date(now.getTime() - MENTION_RETRY_WINDOW_MS) },
      },
      data: { status: "FAILED", outcome: "재시도 시한(60분)을 넘겨 만료됐습니다.", completedAt: now },
    }),
    prisma.teammateRun.updateMany({
      where: { status: "PROCESSING", startedAt: { lt: new Date(now.getTime() - PATROL_STALE_MS) } },
      data: { status: "FAILED", outcome: "worker 중단으로 실행 결과를 확인할 수 없습니다.", completedAt: now },
    }),
    prisma.teammateRun.updateMany({
      where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - PATROL_PENDING_EXPIRE_MS) } },
      data: { status: "FAILED", outcome: "24시간 안에 소화되지 못해 만료됐습니다.", completedAt: now },
    }),
  ]);
  return {
    mentionRetry: mentionRetry.count,
    mentionExpired: mentionExpired.count,
    stale: stale.count,
    expired: expired.count,
  };
}

// ── 이슈 등록(operator-command-worker 가 호출) ──────────────────────────────

export async function registerTeammateFinding(input: {
  runId: string;
  findingIndex: number;
}): Promise<{ message: string; summary: string }> {
  const run = await prisma.teammateRun.findUnique({
    where: { id: input.runId },
    select: { id: true, teammate: true, findings: true, issueUrls: true },
  });
  if (!run) throw new Error("순찰 기록을 찾을 수 없습니다.");
  const findings = parsePatrolFindings(run.findings);
  const item = findings[input.findingIndex];
  if (!item) throw new Error("초안을 찾을 수 없습니다.");
  const decision = registrationDecision(item);
  if (decision.action === "already") {
    return { message: `✅ 이미 등록된 이슈입니다: ${decision.issueUrl}`, summary: "이미 등록된 이슈" };
  }

  // 등록 직전 재확인 — 초안 생성과 버튼 클릭 사이에 같은 이슈가 생겼을 수 있다.
  const existing = await fetchExistingMarkers(
    [decision.repoFullName],
    new Date(Date.now() - DEDUPE_WINDOW_DAYS * DAY_MS),
  );
  const duplicateUrl = existing.get(`${run.teammate}:${item.key}`);

  let message: string;
  let summary: string;
  if (duplicateUrl) {
    item.status = "deduped";
    item.issueUrl = duplicateUrl;
    message = `기존 이슈가 이미 있습니다: ${duplicateUrl}`;
    summary = "중복 이슈로 등록 생략";
  } else {
    const issue = await createIssue({
      repoFullName: decision.repoFullName,
      title: item.title,
      body: buildIssueBody(run.teammate, item),
      labels: [`teammate:${run.teammate}`, ...item.labels],
    });
    item.status = "registered";
    item.issueUrl = issue.html_url;
    message = `✅ 이슈 생성 완료: [${decision.repoFullName} #${issue.number}](${issue.html_url})`;
    summary = `이슈 #${issue.number} 생성`;
  }

  const issueUrls = Array.isArray(run.issueUrls)
    ? run.issueUrls.filter((url): url is string => typeof url === "string")
    : [];
  if (item.issueUrl && item.status === "registered" && !issueUrls.includes(item.issueUrl)) {
    issueUrls.push(item.issueUrl);
  }
  await prisma.teammateRun.update({
    where: { id: run.id },
    data: {
      findings: findings as unknown as Prisma.InputJsonValue,
      issueUrls: issueUrls as unknown as Prisma.InputJsonValue,
    },
  });
  return { message, summary };
}
