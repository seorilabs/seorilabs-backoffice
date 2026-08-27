import {
  APP_STORE_CONFIG_PATH,
  GODOT_PROJECT_PATHS,
  GOOGLE_PLAY_CONFIG_PATH,
  RELEASE_VERSION_CONTRACT_SCRIPT,
  TAG_DERIVED_VERSION_SCRIPT,
  type ReleaseSourceFiles,
} from "@/lib/core/release-source-contract";

/** 계약 입력 파일 조회 포트. 모든 조회는 ref 를 명시적으로 받는다. */
export interface ReleaseSourceReaders {
  readText(path: string, ref: string): Promise<string | null>;
  readJson(path: string, ref: string): Promise<unknown | null>;
}

/**
 * 확정된 SHA 한 곳에서 릴리스 버전 계약 입력을 모두 읽는다.
 *
 * ref 를 브랜치나 태그 이름으로 넘기면 조회 사이에 ref 가 움직여 원장이 갈라질 수 있다.
 * 호출부가 먼저 SHA 를 확정하고 그 SHA 만 넘긴다 — 이 함수는 받은 sha 외의 ref 를 쓰지 않는다.
 */
export async function collectReleaseSourceFiles(
  sha: string,
  readers: ReleaseSourceReaders,
): Promise<ReleaseSourceFiles> {
  const [contractScript, tagDerivedScript, googlePlay, appStore, godotFiles] =
    await Promise.all([
      readers.readText(RELEASE_VERSION_CONTRACT_SCRIPT, sha),
      readers.readText(TAG_DERIVED_VERSION_SCRIPT, sha),
      readers.readJson(GOOGLE_PLAY_CONFIG_PATH, sha),
      readers.readJson(APP_STORE_CONFIG_PATH, sha),
      Promise.all(GODOT_PROJECT_PATHS.map((path) => readers.readText(path, sha))),
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
