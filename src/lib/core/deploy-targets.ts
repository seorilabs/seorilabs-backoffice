export type DeployTarget = "AIT" | "PLAY" | "APPSTORE" | "ALL";

// 백오피스가 dispatch 하는 표준 caller 워크플로 파일.
export const MARKET_WORKFLOW: Record<DeployTarget, string> = {
  AIT: "deploy-apps-in-toss.yml",
  PLAY: "deploy-google-play.yml",
  APPSTORE: "deploy-app-store.yml",
  ALL: "deploy-all.yml",
};

/**
 * deploy-all 은 마켓 배포를 재사용 워크플로 잡으로 묶어 돌린다. 재사용 워크플로는 자체
 * workflow_run 이벤트를 만들지 않아 마켓별 ReleaseRecord 가 파생되지 않으므로, 이 실행
 * 자체의 결과를 알려야 ALL 배포의 완료 여부가 남는다. 표시 이름은 repo 마다 다를 수 있어
 * (`Deploy All`/`Deploy All Markets`) dispatch 대상과 같은 워크플로 파일명으로 판별한다.
 */
export function isDeployAllWorkflow(path: string | null | undefined): boolean {
  return typeof path === "string" && path.split("/").pop() === MARKET_WORKFLOW.ALL;
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
