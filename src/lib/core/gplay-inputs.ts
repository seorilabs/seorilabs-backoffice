// Google Play 업로드 토글 input 은 repo 마다 이름이 다르다(레거시 self-contained caller vs org
// 재사용 caller). 선언된 것 중 하나에 true 를 준다. 하나도 없으면 업로드를 보장할 수 없어 중단.
// octokit 등 무거운 의존 없이 순수하게 유지한다(단위 테스트 대상).
export const GOOGLE_PLAY_UPLOAD_TOGGLES = ["upload", "send_to_google_play", "upload_to_internal"];

/**
 * 선언된 입력(declared)과 태그로부터 Google Play 업로드 입력을 구성한다(순수, 테스트 가능).
 * 선언 안 된 입력을 넘기면 GitHub 이 422 로 거부하므로, 이름이 repo 마다 다른 업로드 토글/배포옵션/
 * Godot 필수값을 declared 에 있는 것만 채운다. 토글이 하나도 없으면 업로드 보장 불가 → 에러(태그 명시).
 */
export function buildGooglePlayUploadInputs(
  declared: Set<string>,
  tag: string,
  ctx: { repoFullName: string; workflowFile: string },
): Record<string, string> {
  const toggle = GOOGLE_PLAY_UPLOAD_TOGGLES.find((n) => declared.has(n));
  if (!toggle) {
    throw new Error(
      `${ctx.repoFullName} 의 ${ctx.workflowFile}(태그 ${tag})에 Google Play 업로드 토글 입력이 없습니다` +
        ` (${GOOGLE_PLAY_UPLOAD_TOGGLES.join("/")}). 업로드 토글이 포함된 최신 태그로 다시 배포하세요.`,
    );
  }
  const out: Record<string, string> = { [toggle]: "true" };

  // 내부 테스터에게 배포(완료 상태). 이름이 repo 마다 달라 선언된 것만 채운다.
  if (declared.has("after_upload")) out.after_upload = "내부 테스터에게 배포하기";
  if (declared.has("track")) out.track = "internal";
  if (declared.has("release_status")) out.release_status = "completed";
  // Godot caller 는 version_name 이 required. 태그에서 파생(vX.Y.Z → X.Y.Z).
  if (declared.has("version_name")) out.version_name = tag.replace(/^v/i, "");
  return out;
}
