// deploy-all caller 에 보낼 입력 중, repo 마다 선언 여부가 갈리는 것을 구성한다.
// octokit 등 무거운 의존 없이 순수하게 유지한다(단위 테스트 대상).

/**
 * iOS 를 Xcode Cloud 로 빌드하는 repo 의 ALL 배포에서 deploy-all 의 App Store 잡을 끈다.
 *
 * App Store 를 애초에 deploy-all 에서 빼 버린 repo 는 이 입력을 선언하지 않는다
 * (예: Xcode Cloud 이관 뒤 deploy-app-store.yml 을 삭제한 Godot repo). 선언되지 않은
 * 입력을 보내면 GitHub 이 422 로 거부해 ALL 배포가 통째로 막히므로, 선언된 경우에만 채운다.
 */
export function buildDeployAllAppStoreInputs(
  declared: ReadonlySet<string>,
): Record<string, string> {
  return declared.has("deploy_app_store") ? { deploy_app_store: "false" } : {};
}
