import type { ReleaseMarket } from "@prisma/client";

export type DeployTarget = "AIT" | "PLAY" | "APPSTORE" | "ALL";

// 백오피스가 dispatch 하는 표준 caller 워크플로 파일.
export const MARKET_WORKFLOW: Record<DeployTarget, string> = {
  AIT: "deploy-apps-in-toss.yml",
  PLAY: "deploy-google-play.yml",
  APPSTORE: "deploy-app-store.yml",
  ALL: "deploy-all.yml",
};

// 재빌드 없이 internal → production 으로 올리는 org 승격 워크플로.
export const PROMOTE_WORKFLOW = "promote-google-play.yml";

// 워크플로 판별은 표시 이름이 아니라 dispatch 대상 파일명으로 한다. 같은 워크플로라도
// repo 마다 name 이 다르고(`Deploy All`/`Deploy All Markets`) 한국어로 바뀔 수도 있다.

/**
 * deploy-all 은 마켓 배포를 재사용 워크플로 잡으로 묶어 돌린다. 재사용 워크플로는 자체
 * workflow_run 이벤트를 만들지 않아 마켓별 ReleaseRecord 가 파생되지 않으므로, 이 실행
 * 자체의 결과를 알려야 ALL 배포의 완료 여부가 남는다.
 */
export function isDeployAllWorkflow(path: string | null | undefined): boolean {
  return typeof path === "string" && path.split("/").pop() === MARKET_WORKFLOW.ALL;
}

/** 승격 실행 여부. 승격이 만든 배포 카드에 다시 승격 버튼을 달지 않기 위해 쓴다. */
export function isPromoteGooglePlayWorkflow(path: string | null | undefined): boolean {
  return typeof path === "string" && path.split("/").pop() === PROMOTE_WORKFLOW;
}

const MARKET_BY_WORKFLOW_FILE: Record<string, ReleaseMarket> = {
  [MARKET_WORKFLOW.AIT]: "AIT",
  [MARKET_WORKFLOW.PLAY]: "PLAY",
  [MARKET_WORKFLOW.APPSTORE]: "APPSTORE",
  [PROMOTE_WORKFLOW]: "PLAY",
};

/**
 * 표준 caller 워크플로 파일 → 마켓. 표시 이름 기반 판별보다 정확하다.
 * 승격 워크플로의 name 이 repo 마다 달라도 PLAY 배포 기록이 파생되도록 보장한다.
 */
export function marketFromWorkflowPath(
  path: string | null | undefined,
): ReleaseMarket | null {
  if (typeof path !== "string") return null;
  return MARKET_BY_WORKFLOW_FILE[path.split("/").pop() ?? ""] ?? null;
}

export const DEPLOY_TARGET_KO: Record<DeployTarget, string> = {
  AIT: "AppsInToss",
  PLAY: "Google Play",
  APPSTORE: "App Store",
  ALL: "전체(Deploy All)",
};

// App.marketTargets(Json) → 배포 대상 후보.
export function deployTargetsFor(marketTargets: unknown): DeployTarget[] {
  const arr = Array.isArray(marketTargets) ? (marketTargets as string[]) : [];
  const out: DeployTarget[] = [];
  if (arr.includes("ait")) out.push("AIT");
  if (arr.includes("play")) out.push("PLAY");
  if (arr.includes("appstore")) out.push("APPSTORE");
  if (out.length > 1) out.push("ALL");
  return out;
}
