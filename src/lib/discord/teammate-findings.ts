import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TeammateKey, TeammateMeta } from "@/lib/discord/teammates";

// 순찰 발견(finding)의 데이터 모델과 순수 로직. octokit 등 외부 클라이언트에
// 닿는 실행 경로는 teammate-patrol.ts 에 있다(테스트와 web 번들 분리 목적).

export const MAX_DRAFTS_PER_RUN = 3;

export interface PatrolFinding {
  key: string;
  title: string;
  detail: string;
  repoFullName: string | null;
  labels: string[];
  evidence: string[];
  status: "drafted" | "deduped" | "skipped" | "registered";
  suggestion?: string;
  issueUrl?: string;
  /** 사람 confirm 없이 자동 등록된 발견(P1·P2 게이트). 채택률 집계의 분모다. */
  auto?: boolean;
  /** confirm 카드 Discord 메시지 ID — 3일 만료 시 카드를 갱신하는 데 쓴다. */
  cardMessageId?: string;
}

export function patrolDedupeKey(key: TeammateKey, now = new Date()): string {
  const kstDate = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
  return `patrol:${key}:${kstDate}`;
}

const MARKER_PREFIX = "seori-teammate";

export function teammateIssueMarker(role: string, findingKey: string): string {
  return `<!-- ${MARKER_PREFIX}:${role}:${findingKey} -->`;
}

/**
 * marker "<teammate>:<findingKey>" 에서 팀원 접두를 벗긴 finding key.
 * finding key 는 앱/이슈 식별자를 품어 팀원과 무관하게 유일하므로, 담당제 전환
 * 이전 직군 팀원이 등록한 이슈와도 dedupe 가 이어진다.
 */
export function markerFindingKey(marker: string): string {
  const idx = marker.indexOf(":");
  return idx === -1 ? marker : marker.slice(idx + 1);
}

export function extractTeammateMarkers(body: string): string[] {
  const markers: string[] = [];
  for (const match of body.matchAll(/<!--\s*seori-teammate:([^\s>]+)\s*-->/g)) {
    markers.push(match[1]);
  }
  return markers;
}

/** 초안 선정 — 근거 게이트(evidence·대상 레포)와 실행당 상한을 코드로 강제한다. */
export function selectDraftIndexes(findings: readonly PatrolFinding[]): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < findings.length && indexes.length < MAX_DRAFTS_PER_RUN; i++) {
    const item = findings[i];
    if (item.status !== "skipped") continue; // deduped/registered 는 제외
    if (!item.repoFullName || item.evidence.length === 0) continue;
    indexes.push(i);
  }
  return indexes;
}

export const AUTO_ADOPTION_WINDOW_DAYS = 14;
export const AUTO_ADOPTION_MIN_SAMPLE = 5;
export const DRAFT_EXPIRE_DAYS = 3;

/** P1·P2 발견만 사람 confirm 없이 자동 등록할 수 있다. */
export function isAutoRegisterPriority(labels: readonly string[]): boolean {
  return labels.includes("P1") || labels.includes("P2");
}

/**
 * 자동 등록 대상 선정 — 초안 요건(대상 레포·근거)에 우선순위 게이트(P1·P2)와
 * 실행당 상한을 더한다. 순찰은 dedupeKey 로 팀원당 하루 1회라 실행당 상한이
 * 곧 일일 상한이다.
 */
export function selectAutoRegisterIndexes(
  findings: readonly PatrolFinding[],
  limit: number,
): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < findings.length && indexes.length < limit; i++) {
    const item = findings[i];
    if (item.status !== "skipped") continue;
    if (!item.repoFullName || item.evidence.length === 0) continue;
    if (!isAutoRegisterPriority(item.labels)) continue;
    indexes.push(i);
  }
  return indexes;
}

export interface AutoAdoptionStats {
  registered: number;
  notPlanned: number;
}

/**
 * 채택률 게이트 — 최근 자동 등록 이슈 중 NOT_PLANNED 종료 비율이 기준을 넘으면
 * 자동 등록을 멈추고 전량 confirm 카드로 되돌린다. 상태를 저장하지 않고 매 순찰
 * 재평가하므로 채택률이 회복되면 자동으로 재개된다.
 */
export function evaluateAutoRegistration(
  stats: AutoAdoptionStats,
  opts: { minSample: number; disablePct: number },
): { enabled: boolean; reason?: string } {
  if (stats.registered < opts.minSample) return { enabled: true };
  const pct = Math.round((stats.notPlanned / stats.registered) * 100);
  if (pct >= opts.disablePct) {
    return {
      enabled: false,
      reason: `최근 자동 등록 ${stats.registered}건 중 NOT_PLANNED ${stats.notPlanned}건(${pct}%) — 수동 confirm 으로 복귀`,
    };
  }
  return { enabled: true };
}

export function parseIssueUrl(url: string): { repoFullName: string; number: number } | null {
  const match = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(url);
  if (!match) return null;
  return { repoFullName: match[1], number: Number(match[2]) };
}

/** 최근 자동 등록 이슈의 채택 통계 — issueMirror 의 CLOSED+not_planned 로 판별. */
export async function collectAutoAdoptionStats(windowDays: number): Promise<AutoAdoptionStats> {
  const runs = await prisma.teammateRun.findMany({
    where: {
      trigger: "schedule",
      status: "COMPLETED",
      createdAt: { gte: new Date(Date.now() - windowDays * 86_400_000) },
    },
    select: { findings: true },
    take: 300,
  });
  const registeredUrls: Array<{ repoFullName: string; number: number }> = [];
  for (const run of runs) {
    for (const item of parsePatrolFindings(run.findings)) {
      if (!item.auto || item.status !== "registered" || !item.issueUrl) continue;
      const parsed = parseIssueUrl(item.issueUrl);
      if (parsed) registeredUrls.push(parsed);
    }
  }
  if (registeredUrls.length === 0) return { registered: 0, notPlanned: 0 };
  const mirrors = await prisma.issueMirror.findMany({
    where: { OR: registeredUrls.map((issue) => ({ repoFullName: issue.repoFullName, number: issue.number })) },
    select: { state: true, stateReason: true },
  });
  const notPlanned = mirrors.filter(
    (issue) => issue.state === "CLOSED" && issue.stateReason === "not_planned",
  ).length;
  return { registered: registeredUrls.length, notPlanned };
}

/** 3일 넘게 confirm 되지 않은 drafted 초안의 인덱스 — 만료(skipped) 대상. */
export function selectExpiredDraftIndexes(
  findings: readonly PatrolFinding[],
  runCreatedAt: Date,
  now: Date,
  ttlDays = DRAFT_EXPIRE_DAYS,
): number[] {
  if (now.getTime() - runCreatedAt.getTime() < ttlDays * 86_400_000) return [];
  const indexes: number[] = [];
  findings.forEach((item, index) => {
    if (item.status === "drafted") indexes.push(index);
  });
  return indexes;
}

export function renderPatrolReport(
  meta: TeammateMeta,
  findings: readonly PatrolFinding[],
  narrative: string,
  // 발견과 무관하게 항상 싣는 현황 스냅샷(예: 파이낸스의 월누적 비용).
  summaryLines: readonly string[] = [],
): string {
  if (findings.length === 0) {
    const lines = [`🔎 **${meta.ko} 순찰 보고**`];
    if (summaryLines.length > 0) lines.push(...summaryLines, "", "경고 없음");
    else lines.push("이상 없음 — 발견 0건");
    return lines.join("\n");
  }
  const drafted = findings.filter((item) => item.status === "drafted").length;
  const deduped = findings.filter((item) => item.status === "deduped").length;
  const registered = findings.filter((item) => item.status === "registered").length;
  const lines = [
    `🔎 **${meta.ko} 순찰 보고**`,
    ...summaryLines,
    `발견 ${findings.length}건 · 자동 등록 ${registered}건 · 이슈 초안 ${drafted}건 · 기존 이슈 중복 ${deduped}건`,
  ];
  if (narrative) lines.push("", narrative);
  findings.forEach((item, index) => {
    const tag =
      item.status === "deduped" ? " (기존 이슈 있음)" : item.status === "registered" ? " (자동 등록됨)" : "";
    lines.push("", `**${index + 1}. ${item.title}**${tag}`);
    for (const evidence of item.evidence) lines.push(`- ${evidence}`);
    if (item.status === "deduped" && item.issueUrl) lines.push(`- 기존 이슈: ${item.issueUrl}`);
    if (item.status === "registered" && item.issueUrl) lines.push(`- 등록된 이슈: ${item.issueUrl}`);
  });
  return lines.join("\n");
}

export function buildIssueBody(role: string, item: PatrolFinding): string {
  const lines = [
    item.detail,
    "",
    "## 근거",
    ...item.evidence.map((evidence) => `- ${evidence}`),
  ];
  if (item.suggestion) lines.push("", "## 제안", item.suggestion);
  lines.push("", `발굴: Seorilabs AI 팀원 순찰 (${role})`, "", teammateIssueMarker(role, item.key));
  return lines.join("\n");
}

export function parsePatrolFindings(value: Prisma.JsonValue | null): PatrolFinding[] {
  if (!Array.isArray(value)) return [];
  const result: PatrolFinding[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.key !== "string" || typeof record.title !== "string") continue;
    result.push({
      key: record.key,
      title: record.title,
      detail: typeof record.detail === "string" ? record.detail : "",
      repoFullName: typeof record.repoFullName === "string" ? record.repoFullName : null,
      labels: Array.isArray(record.labels)
        ? record.labels.filter((label): label is string => typeof label === "string")
        : [],
      evidence: Array.isArray(record.evidence)
        ? record.evidence.filter((line): line is string => typeof line === "string")
        : [],
      status:
        record.status === "drafted" || record.status === "deduped" || record.status === "registered"
          ? record.status
          : "skipped",
      ...(typeof record.suggestion === "string" ? { suggestion: record.suggestion } : {}),
      ...(typeof record.issueUrl === "string" ? { issueUrl: record.issueUrl } : {}),
      ...(record.auto === true ? { auto: true } : {}),
      ...(typeof record.cardMessageId === "string" ? { cardMessageId: record.cardMessageId } : {}),
    });
  }
  return result;
}

export type RegistrationDecision =
  | { action: "already"; issueUrl: string }
  | { action: "register"; repoFullName: string };

/**
 * 등록 버튼 처리의 판정. 재클릭(이미 registered)은 멱등으로 기존 URL 을 알리고,
 * drafted 가 아니거나 근거·대상 레포가 없는 초안은 등록을 거부한다.
 */
export function registrationDecision(item: PatrolFinding): RegistrationDecision {
  if (item.status === "registered" && item.issueUrl) {
    return { action: "already", issueUrl: item.issueUrl };
  }
  if (item.status !== "drafted") throw new Error("등록 대상 초안이 아닙니다.");
  if (!item.repoFullName || item.evidence.length === 0) {
    throw new Error("근거 없는 초안은 등록할 수 없습니다.");
  }
  return { action: "register", repoFullName: item.repoFullName };
}

/** 초안 폐기 — drafted 상태만 skipped 로 되돌린다(웹 interaction 경로에서 호출). */
export async function skipTeammateFinding(runId: string, findingIndex: number): Promise<boolean> {
  const run = await prisma.teammateRun.findUnique({ where: { id: runId }, select: { findings: true } });
  if (!run) return false;
  const findings = parsePatrolFindings(run.findings);
  const item = findings[findingIndex];
  if (!item || item.status !== "drafted") return false;
  item.status = "skipped";
  await prisma.teammateRun.update({
    where: { id: runId },
    data: { findings: findings as unknown as Prisma.InputJsonValue },
  });
  return true;
}
