import {
  bumpStableSemVerTag,
  compareStableSemVerTags,
  normalizeStableSemVerTag,
  parseStableSemVerTag,
} from "@/lib/core/stable-semver";
import { buildGooglePlayUploadInputs } from "@/lib/core/gplay-inputs";
import type { DeployTarget } from "@/lib/core/deploy-targets";

const SNAPSHOT_CANDIDATE_RE =
  /^(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-snapshot\.([1-9]\d*)$/;

export const SNAPSHOT_MAX_SEQUENCE = 99;

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

export function assertSnapshotTargetsUnchanged(
  expectedTargets: readonly SnapshotDeployTarget[],
  currentTargets: readonly SnapshotDeployTarget[],
): void {
  const unchanged = expectedTargets.length === currentTargets.length &&
    expectedTargets.every((value, index) => value === currentTargets[index]);
  if (!unchanged) {
    throw new Error("확인 후 테스트 배포 대상이 변경됐습니다. 다시 요청해 확인하세요.");
  }
}

export function assertSnapshotShaUnchanged(
  expectedSha: string,
  currentSha: string,
): void {
  if (currentSha !== expectedSha) {
    throw new Error(
      `main HEAD가 ${expectedSha.slice(0, 7)}에서 ${currentSha.slice(0, 7)}(으)로 변경됐습니다. 다시 요청해 확인하세요.`,
    );
  }
}

export function assertSnapshotCandidateTagUnchanged(
  expectedTag: string,
  currentTag: string,
): void {
  if (currentTag !== expectedTag) {
    throw new Error(
      `확인 후 다음 snapshot 후보가 ${expectedTag}에서 ${currentTag}(으)로 변경됐습니다. 다시 요청해 확인하세요.`,
    );
  }
}

export function assertSnapshotRegistryUnchanged(input: {
  expectedRepoFullName: string;
  currentRepoFullName: string;
  expectedTargets: readonly SnapshotDeployTarget[];
  expectedIosBundle?: string | null;
  currentIosBundle?: string | null;
}): void {
  if (input.expectedRepoFullName !== input.currentRepoFullName) {
    throw new Error("확인 후 앱 저장소가 변경됐습니다. 다시 요청해 확인하세요.");
  }
  if (
    input.expectedTargets.includes("TESTFLIGHT") &&
    (input.expectedIosBundle ?? "") !== (input.currentIosBundle ?? "")
  ) {
    throw new Error("확인 후 iOS bundle ID가 변경됐습니다. 다시 요청해 확인하세요.");
  }
}

function optionalStableTag(value: unknown): string | null {
  if (typeof value !== "string" || !parseStableSemVerTag(value)) return null;
  return normalizeStableSemVerTag(value);
}

export function parseSnapshotCandidateTag(
  raw: string,
): { baseTag: string; sequence: number } | null {
  const match = raw.match(SNAPSHOT_CANDIDATE_RE);
  if (!match) return null;
  const sequence = Number(match[2]);
  if (sequence > SNAPSHOT_MAX_SEQUENCE) return null;
  return { baseTag: match[1], sequence };
}

/**
 * 다음 snapshot 후보의 stable base를 계산한다.
 *
 * 이미 공개에 사용한 stable 태그·마켓 원장이 있으면 그 최댓값의 다음 patch를 쓴다.
 * main package.json이 그보다 높은 버전을 미리 선언했다면 해당 선언을 존중하고 다시
 * 증가시키지 않는다. 아직 공개 이력이 없는 앱은 package version을 첫 후보 base로 쓴다.
 */
export function resolveSnapshotCandidateBase(input: {
  tags: readonly string[];
  marketFloor?: string | null;
  packageVersion?: unknown;
}): string {
  const published = [
    ...input.tags.filter((tag) => parseStableSemVerTag(tag) !== null),
    input.marketFloor,
  ].filter((value): value is string => Boolean(value))
    .map(normalizeStableSemVerTag);
  const publishedFloor = published
    .sort((a, b) => compareStableSemVerTags(b, a))[0] ?? null;
  const packageVersion = optionalStableTag(input.packageVersion);

  if (!publishedFloor) {
    if (packageVersion) return packageVersion;
    throw new Error(
      "stable SemVer 태그나 main package.json version이 없어 후보 버전을 계산할 수 없습니다.",
    );
  }

  const nextPublishedPatch = bumpStableSemVerTag(publishedFloor, "patch");
  if (
    packageVersion &&
    compareStableSemVerTags(packageVersion, nextPublishedPatch) > 0
  ) {
    return packageVersion;
  }
  return nextPublishedPatch;
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
  if (latestSequence >= SNAPSHOT_MAX_SEQUENCE) {
    throw new Error(
      `${normalizedBase} snapshot 순번 1..${SNAPSHOT_MAX_SEQUENCE}를 모두 사용했습니다. ` +
        "package version을 다음 stable base로 올린 뒤 다시 요청하세요.",
    );
  }
  return `${normalizedBase}-snapshot.${latestSequence + 1}`;
}

export function buildSnapshotDeployInputs(
  declaredInputs: ReadonlySet<string>,
  tag: string,
  sha: string,
  context?: { repoFullName: string; workflowFile: string },
): Record<string, string> {
  if (!declaredInputs.has("snapshot_candidate")) {
    const workflow = context
      ? `${context.repoFullName} ${context.workflowFile}`
      : "workflow";
    throw new Error(
      `${workflow}에 snapshot_candidate 입력이 없어 snapshot 후보를 안전하게 실행할 수 없습니다.`,
    );
  }

  const inputs: Record<string, string> = { snapshot_candidate: "true" };
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
  const inputs = buildSnapshotDeployInputs(declaredInputs, tag, sha, context);
  if (target === "AIT") {
    if (declaredInputs.has("upload")) inputs.upload = "true";
    return inputs;
  }

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

/** deploy와 같은 선택값을 snapshot 내부 테스트 채널로 변환한다. */
export function selectSnapshotDeployTargets(
  marketTargets: unknown,
  target: DeployTarget,
): SnapshotDeployTarget[] {
  const available = snapshotDeployTargetsFor(marketTargets);
  if (target === "ALL") {
    if (available.length === 0) {
      throw new Error("snapshot 후보를 배포할 등록 마켓이 없습니다.");
    }
    return available;
  }

  const selected: SnapshotDeployTarget =
    target === "APPSTORE" ? "TESTFLIGHT" : target;
  if (!available.includes(selected)) {
    throw new Error(
      `${SNAPSHOT_DEPLOY_TARGET_KO[selected]}가 등록되지 않아 snapshot 후보를 배포할 수 없습니다.`,
    );
  }
  return [selected];
}

/** workflow_run이 후보 버전을 식별하도록 실제 실행 ref를 후보 태그로 고정한다. */
export function resolveSnapshotDeployDispatchRef(
  tag: string,
): string {
  return tag;
}
