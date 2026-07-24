export type DeployTarget = "AIT" | "PLAY" | "APPSTORE" | "ALL";

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
