import { getRepoJsonFile, getRepoTextFile } from "@/lib/github/read";
import {
  APP_STORE_CONFIG_PATH,
  GODOT_PROJECT_PATHS,
  GOOGLE_PLAY_CONFIG_PATH,
  RELEASE_VERSION_CONTRACT_SCRIPT,
  TAG_DERIVED_VERSION_SCRIPT,
  type ReleaseSourceFiles,
} from "@/lib/core/release-source-contract";

/**
 * 확정된 SHA 한 곳에서 릴리스 버전 계약 입력을 모두 읽는다.
 *
 * ref 를 브랜치나 태그 이름으로 넘기면 조회 사이에 ref 가 움직여 원장이 갈라질 수 있다.
 * 호출부가 먼저 SHA 를 확정하고 그 SHA 만 넘긴다.
 */
export async function readReleaseSourceFiles(
  repoFullName: string,
  sha: string,
): Promise<ReleaseSourceFiles> {
  const [contractScript, tagDerivedScript, googlePlay, appStore, godotFiles] =
    await Promise.all([
      getRepoTextFile(repoFullName, RELEASE_VERSION_CONTRACT_SCRIPT, sha),
      getRepoTextFile(repoFullName, TAG_DERIVED_VERSION_SCRIPT, sha),
      getRepoJsonFile(repoFullName, GOOGLE_PLAY_CONFIG_PATH, sha),
      getRepoJsonFile(repoFullName, APP_STORE_CONFIG_PATH, sha),
      Promise.all(
        GODOT_PROJECT_PATHS.map((path) => getRepoTextFile(repoFullName, path, sha)),
      ),
    ]);

  const godotIndex = godotFiles.findIndex((text) => text !== null);
  const godotText = godotIndex === -1 ? null : godotFiles[godotIndex];
  return {
    sha,
    hasContractScript: contractScript !== null,
    hasTagDerivedScript: tagDerivedScript !== null,
    godotProject:
      godotText === null
        ? null
        : { path: GODOT_PROJECT_PATHS[godotIndex], text: godotText },
    googlePlay,
    appStore,
  };
}
