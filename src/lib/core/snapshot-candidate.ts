import {
  compareStableSemVerTags,
  normalizeStableSemVerTag,
  parseStableSemVerTag,
} from "@/lib/core/stable-semver";
import { buildGooglePlayUploadInputs } from "@/lib/core/gplay-inputs";

const SNAPSHOT_CANDIDATE_RE =
  /^(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-snapshot\.([1-9]\d*)$/;

export const SNAPSHOT_BRANCH = "main";

export function assertSnapshotDefaultBranch(
  defaultBranch: string,
): asserts defaultBranch is typeof SNAPSHOT_BRANCH {
  if (defaultBranch !== SNAPSHOT_BRANCH) {
    throw new Error(
      `기본 브랜치가 ${SNAPSHOT_BRANCH}이 아닙니다: ${defaultBranch}`,
    );
  }
}

export type SnapshotDeployTarget = "AIT" | "PLAY" | "TESTFLIGHT";

export const SNAPSHOT_DEPLOY_TARGET_KO: Record<SnapshotDeployTarget, string> = {
  AIT: "AppsInToss",
  PLAY: "Google Play 내부 테스트",
  TESTFLIGHT: "TestFlight 내부 테스트",
};

function optionalStableTag(value: unknown): string | null {
  if (typeof value !== "string" || !parseStableSemVerTag(value)) return null;
  return normalizeStableSemVerTag(value);
}

export function parseSnapshotCandidateTag(
  raw: string,
): { baseTag: string; sequence: number } | null {
  const match = raw.match(SNAPSHOT_CANDIDATE_RE);
  if (!match) return null;
  return { baseTag: match[1], sequence: Number(match[2]) };
}

/** 태그·마켓 원장·main package.json 중 가장 높은 stable SemVer를 후보 기준으로 쓴다. */
export function resolveSnapshotCandidateBase(input: {
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
      "stable SemVer 태그나 main package.json version이 없어 후보 버전을 계산할 수 없습니다.",
    );
  }
  return base;
}

export function nextSnapshotCandidateTag(
  baseTag: string,
  existingTags: readonly string[],
): string {
  const normalizedBase = normalizeStableSemVerTag(baseTag);
  let latestSequence = 0;
  for (const tag of existingTags) {
    const parsed = parseSnapshotCandidateTag(tag);
    if (parsed?.baseTag === normalizedBase) {
      latestSequence = Math.max(latestSequence, parsed.sequence);
    }
  }
  return `${normalizedBase}-snapshot.${latestSequence + 1}`;
}

export function buildSnapshotDeployInputs(
  declaredInputs: ReadonlySet<string>,
  tag: string,
  sha: string,
): Record<string, string> {
  const inputs: Record<string, string> = {};
  if (declaredInputs.has("release_tag")) inputs.release_tag = tag;
  if (declaredInputs.has("memo")) {
    inputs.memo = `snapshot candidate ${tag} (${sha.slice(0, 7)})`;
  }
  // 레거시 caller가 배포 뒤 별도 순번 태그를 만드는 경우 후보 태그와 이중 기록되지 않게 막는다.
  if (declaredInputs.has("create_release_tag")) inputs.create_release_tag = "false";
  return inputs;
}

export function buildSnapshotMarketInputs(
  target: "AIT" | "PLAY",
  declaredInputs: ReadonlySet<string>,
  tag: string,
  sha: string,
  context: { repoFullName: string; workflowFile: string },
): Record<string, string> {
  const inputs = buildSnapshotDeployInputs(declaredInputs, tag, sha);
  if (target !== "PLAY") return inputs;

  const parsed = parseSnapshotCandidateTag(tag);
  if (!parsed) throw new Error(`snapshot 후보 태그 형식이 아닙니다: ${tag}`);
  Object.assign(
    inputs,
    buildGooglePlayUploadInputs(declaredInputs, tag, context),
  );
  // Godot caller의 명시 version_name은 숫자 SemVer를 요구한다. 후보 식별은
  // release_tag가 소유하고 Play 표시 버전은 기반 SemVer로 유지한다.
  if (declaredInputs.has("version_name")) {
    inputs.version_name = parsed.baseTag.slice(1);
  }
  return inputs;
}

/** 앱 레지스트리의 실제 배포 가능 마켓만 snapshot 테스트 배포 대상으로 사용한다. */
export function snapshotDeployTargetsFor(
  marketTargets: unknown,
): SnapshotDeployTarget[] {
  const values = Array.isArray(marketTargets)
    ? new Set(marketTargets.filter((value): value is string => typeof value === "string"))
    : new Set<string>();
  const targets: SnapshotDeployTarget[] = [];
  if (values.has("ait")) targets.push("AIT");
  if (values.has("play")) targets.push("PLAY");
  if (values.has("appstore")) targets.push("TESTFLIGHT");
  return targets;
}

/** workflow_run이 후보 버전을 식별하도록 실제 실행 ref를 후보 태그로 고정한다. */
export function resolveSnapshotDeployDispatchRef(
  tag: string,
): string {
  return tag;
}
