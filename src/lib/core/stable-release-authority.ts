import { normalizeStableSemVerTag } from "@/lib/core/stable-semver";

const COMMIT_SHA = /^[a-f0-9]{40}$/u;

export const STABLE_RELEASE_AUTHORITY = "github-stable-tag" as const;

export interface StableReleaseAuthority {
  kind: typeof STABLE_RELEASE_AUTHORITY;
  tag: string;
  sha: string;
}

/** 같은 입력을 재시도해도 해소되지 않는 stable 릴리스 권한 오류. */
export class StableReleaseAuthorityError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "StableReleaseAuthorityError";
  }
}

/** stable 릴리스의 유일한 버전 권한은 exact GitHub tag와 그 tag가 가리키는 commit이다. */
export function stableReleaseAuthority(tag: string, sha: string): StableReleaseAuthority {
  const normalizedTag = normalizeStableSemVerTag(tag);
  const normalizedSha = sha.toLowerCase();
  if (!COMMIT_SHA.test(normalizedSha)) {
    throw new StableReleaseAuthorityError("GitHub stable 태그의 commit SHA가 올바르지 않습니다.");
  }
  return Object.freeze({
    kind: STABLE_RELEASE_AUTHORITY,
    tag: normalizedTag,
    sha: normalizedSha,
  });
}
