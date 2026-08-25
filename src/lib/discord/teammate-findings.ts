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
  const lines = [
    `🔎 **${meta.ko} 순찰 보고**`,
    ...summaryLines,
    `발견 ${findings.length}건 · 이슈 초안 ${drafted}건 · 기존 이슈 중복 ${deduped}건`,
  ];
  if (narrative) lines.push("", narrative);
  findings.forEach((item, index) => {
    lines.push("", `**${index + 1}. ${item.title}**${item.status === "deduped" ? " (기존 이슈 있음)" : ""}`);
    for (const evidence of item.evidence) lines.push(`- ${evidence}`);
    if (item.status === "deduped" && item.issueUrl) lines.push(`- 기존 이슈: ${item.issueUrl}`);
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
