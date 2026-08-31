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

/**
 * Deploy All을 명시적으로 실행한 경우 Play는 build-only가 아니라 internal
 * upload + completed까지가 표준 후보 경계다. 일부 caller는 이 값을 job에
 * 고정하고, 일부는 google_play_* input을 선언하므로 선언된 경우만 명시한다.
 * 선언하지 않은 input을 보내 GitHub 422를 만들지 않는다.
 */
export function buildDeployAllGooglePlayInputs(
  declared: ReadonlySet<string>,
): Record<string, string> {
  const inputs: Record<string, string> = {};
  if (declared.has("deploy_google_play")) inputs.deploy_google_play = "true";
  if (declared.has("google_play_upload")) inputs.google_play_upload = "true";
  if (declared.has("google_play_track")) inputs.google_play_track = "internal";
  if (declared.has("google_play_release_status")) {
    inputs.google_play_release_status = "completed";
  }
  return inputs;
}
