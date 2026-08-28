/**
 * Platform의 immutable release publisher가 GitHub Release와 release-notes.json을
 * 단독 소유한다. 조직명과 저장소명을 정규화한 exact match만 제외해 다른 앱의
 * 기존 tag 기반 출시노트 자동 발행은 그대로 유지한다.
 */
export function shouldBackofficeAutoPublishReleaseNotes(
  repoFullName: string,
  githubOrg: string,
): boolean {
  return repoFullName.toLowerCase() !== `${githubOrg}/platform`.toLowerCase();
}
