import {
  compareStableSemVerTags,
  normalizeStableSemVerTag,
  parseStableSemVerTag,
} from "@/lib/core/stable-semver";

const DEVELOP_CANDIDATE_RE =
  /^(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-develop\.([1-9]\d*)$/;

function optionalStableTag(value: unknown): string | null {
  if (typeof value !== "string" || !parseStableSemVerTag(value)) return null;
  return normalizeStableSemVerTag(value);
}

export function parseDevelopCandidateTag(
  raw: string,
): { baseTag: string; sequence: number } | null {
  const match = raw.match(DEVELOP_CANDIDATE_RE);
  if (!match) return null;
  return { baseTag: match[1], sequence: Number(match[2]) };
}

/** 태그·마켓 원장·develop package.json 중 가장 높은 stable SemVer를 후보 기준으로 쓴다. */
export function resolveDevelopCandidateBase(input: {
  tags: readonly string[];
  marketFloor?: string | null;
  packageVersion?: unknown;
}): string {
  const candidates = [
    ...input.tags.filter((tag) => parseStableSemVerTag(tag) !== null),
    input.marketFloor,
    optionalStableTag(input.packageVersion),
  ].filter((value): value is string => Boolean(value))
    .map(normalizeStableSemVerTag);

  const base = candidates.sort((a, b) => compareStableSemVerTags(b, a))[0];
  if (!base) {
    throw new Error(
      "stable SemVer 태그나 develop package.json version이 없어 후보 버전을 계산할 수 없습니다.",
    );
  }
  return base;
}

export function nextDevelopCandidateTag(
  baseTag: string,
  existingTags: readonly string[],
): string {
  const normalizedBase = normalizeStableSemVerTag(baseTag);
  let latestSequence = 0;
  for (const tag of existingTags) {
    const parsed = parseDevelopCandidateTag(tag);
    if (parsed?.baseTag === normalizedBase) {
      latestSequence = Math.max(latestSequence, parsed.sequence);
    }
  }
  return `${normalizedBase}-develop.${latestSequence + 1}`;
}

export function buildDevelopDeployInputs(
  declaredInputs: ReadonlySet<string>,
  tag: string,
  sha: string,
): Record<string, string> {
  const inputs: Record<string, string> = {};
  if (declaredInputs.has("release_tag")) inputs.release_tag = tag;
  if (declaredInputs.has("memo")) {
    inputs.memo = `develop candidate ${tag} (${sha.slice(0, 7)})`;
  }
  // 레거시 caller가 배포 뒤 별도 순번 태그를 만드는 경우 후보 태그와 이중 기록되지 않게 막는다.
  if (declaredInputs.has("create_release_tag")) inputs.create_release_tag = "false";
  return inputs;
}

/**
 * 표준 caller는 기본 브랜치에 두고 release_tag로 develop 소스를 checkout한다.
 * release_tag 입력이 없는 레거시 caller는 기본 브랜치 자체가 develop일 때만 후보 태그 ref로
 * 실행할 수 있다. 그렇지 않으면 main 소스를 잘못 배포할 수 있으므로 중단한다.
 */
export function resolveDevelopDeployDispatchRef(
  defaultBranch: string,
  declaredInputs: ReadonlySet<string>,
  tag: string,
): string {
  if (declaredInputs.has("release_tag")) return defaultBranch;
  if (defaultBranch === "develop") return tag;
  throw new Error(
    "deploy-apps-in-toss.yml에 release_tag 입력이 없어 develop 소스를 고정할 수 없습니다.",
  );
}
