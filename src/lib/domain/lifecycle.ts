import type { Lifecycle, ReleaseMarket } from "@prisma/client";

// 6단계 라이프사이클. 전이는 수동(보드)이 기본, deploy 성공만 자동 신호.

export const STAGES: Lifecycle[] = [
  "PLANNING",
  "DEVELOPMENT",
  "QA",
  "MARKET_SUBMISSION",
  "RELEASE",
  "LIVEOPS",
];

export const STAGE_KO: Record<Lifecycle, string> = {
  PLANNING: "기획",
  DEVELOPMENT: "개발",
  QA: "QA",
  MARKET_SUBMISSION: "마켓등록",
  RELEASE: "출시",
  LIVEOPS: "운영",
};

// 단계 ↔ GitHub 라벨 (복구성 역기록용).
export const STAGE_LABEL: Record<Lifecycle, string> = {
  PLANNING: "stage:planning",
  DEVELOPMENT: "stage:development",
  QA: "stage:qa",
  MARKET_SUBMISSION: "stage:market",
  RELEASE: "stage:release",
  LIVEOPS: "stage:liveops",
};

export const ALL_STAGE_LABELS = Object.values(STAGE_LABEL);

export function stageIndex(stage: Lifecycle): number {
  return STAGES.indexOf(stage);
}

// QA→MARKET_SUBMISSION 은 사람 승인 게이트.
export function isApprovalGate(from: Lifecycle, to: Lifecycle): boolean {
  return from === "QA" && to === "MARKET_SUBMISSION";
}

// 워크플로 이름 → 마켓.
export function marketFromWorkflowName(
  name: string | null | undefined,
): ReleaseMarket | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes("google") || n.includes("play")) return "PLAY";
  if (n.includes("app store") || n.includes("app-store") || n.includes("appstore") || n.includes("ios"))
    return "APPSTORE";
  if (n.includes("appsintoss") || n.includes("apps-in-toss") || n.includes("ait") || n.includes("toss"))
    return "AIT";
  return null;
}

export function isDeployWorkflow(name: string | null | undefined): boolean {
  return marketFromWorkflowName(name) !== null;
}
