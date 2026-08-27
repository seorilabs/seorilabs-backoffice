import { getRepoJsonFile, getRepoTextFile } from "@/lib/github/read";
import {
  collectReleaseSourceFiles,
  type ReleaseSourceReaders,
} from "@/lib/core/release-source-files";
import type { ReleaseSourceFiles } from "@/lib/core/release-source-contract";

/** GitHub contents API 를 계약 입력 조회 포트로 감싼다. 모든 조회에 SHA 를 명시한다. */
function githubReaders(repoFullName: string): ReleaseSourceReaders {
  return {
    readText: (path, ref) => getRepoTextFile(repoFullName, path, ref),
    readJson: (path, ref) => getRepoJsonFile(repoFullName, path, ref),
  };
}

export function readReleaseSourceFiles(
  repoFullName: string,
  sha: string,
): Promise<ReleaseSourceFiles> {
  return collectReleaseSourceFiles(sha, githubReaders(repoFullName));
}
