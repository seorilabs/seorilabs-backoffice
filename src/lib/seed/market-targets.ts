// marketTargets 파생 로직(순수 함수). registry.ts 의 seedRepo 에서 사용하며,
// octokit/prisma 등 부작용 의존성이 없어 단위 테스트가 가능하다.
//
// 판정 규칙:
//   - play/ait 는 "config 존재" 가 아니라 "기본 브랜치의 표준 배포 워크플로우 파일 존재" 로만 판정한다.
//     (deployTargetsFor 가 marketTargets → 표준 배포 caller 워크플로우로 매핑하므로, 워크플로우가 없으면
//      /deploy dispatch 가 404 난다. 즉 실제로 dispatch 가능한 마켓만 노출한다.)
//   - appstore 는 GitHub 워크플로가 dispatch 대상이 아니다. archive·upload 는 Xcode Cloud 가 하고
//     트리거는 Backoffice 가 ASC ciBuildRuns 로 직접 하므로(shouldUseXcodeCloudForTarget), 저장소에
//     App Store 워크플로를 두지 않는다. 그래서 워크플로 파일이 아니라 "App Store 설정 + 실제 빌드
//     경로" 로 판정한다. 빌드 경로는 Xcode Cloud 훅이거나 dispatch 가능한 App Store 워크플로다.
//     설정만 있고 어느 쪽도 없으면 빌드를 만들 수단이 없으므로 노출하지 않는다.
//   - web 은 web/ 디렉터리 존재로 판정한다(deployTargetsFor 는 web 을 배포 대상으로 만들지 않음).
// 순서는 결정적(deterministic)이어야 configHash 가 안정적이다: play → appstore → ait → web.

export interface MarketTargetSignals {
  /** .github/workflows/deploy-google-play.yml 존재 */
  hasPlayWorkflow: boolean;
  /** app-store/app-store.config.json 존재 */
  hasAppStoreConfig: boolean;
  /** Xcode Cloud ci_scripts 존재(RN: apps/mobile/ios/ci_scripts, Godot: xcode-cloud/ci_scripts) */
  hasXcodeCloudScripts: boolean;
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
  if (signals.hasAppStoreConfig && (signals.hasXcodeCloudScripts || signals.hasAppStoreWorkflow)) {
    targets.push("appstore");
  }
  if (signals.hasAitWorkflow) targets.push("ait");
  if (signals.hasWeb) targets.push("web");
  return targets;
}
