// marketTargets 파생 로직(순수 함수). registry.ts 의 seedRepo 에서 사용하며,
// octokit/prisma 등 부작용 의존성이 없어 단위 테스트가 가능하다.
//
// 판정 규칙:
//   - play/appstore/ait 는 "config 존재" 가 아니라 "기본 브랜치의 표준 배포 워크플로우 파일 존재" 로만 판정한다.
//     (deployTargetsFor 가 marketTargets → 표준 배포 caller 워크플로우로 매핑하므로, 워크플로우가 없으면
//      /deploy dispatch 가 404 난다. 즉 실제로 dispatch 가능한 마켓만 노출한다.)
//   - web 은 web/ 디렉터리 존재로 판정한다(deployTargetsFor 는 web 을 배포 대상으로 만들지 않음).
// 순서는 결정적(deterministic)이어야 configHash 가 안정적이다: play → appstore → ait → web.

export interface MarketTargetSignals {
  /** .github/workflows/deploy-google-play.yml 존재 */
  hasPlayWorkflow: boolean;
  /** .github/workflows/deploy-app-store.yml 존재 */
  hasAppStoreWorkflow: boolean;
  /** .github/workflows/deploy-apps-in-toss.yml 존재 */
  hasAitWorkflow: boolean;
  /** web/ 디렉터리 존재 */
  hasWeb: boolean;
}

export function deriveMarketTargets(signals: MarketTargetSignals): string[] {
  const targets: string[] = [];
  if (signals.hasPlayWorkflow) targets.push("play");
  if (signals.hasAppStoreWorkflow) targets.push("appstore");
  if (signals.hasAitWorkflow) targets.push("ait");
  if (signals.hasWeb) targets.push("web");
  return targets;
}
