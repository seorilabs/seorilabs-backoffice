import { normalizeStableSemVerTag, parseStableSemVerTag } from "@/lib/core/stable-semver";

// 릴리스 소스 버전 계약(순수 모듈 — GitHub 호출 없음).
//
// 배경(장애): Backoffice 가 tag >= 마켓 원장(floor) 만 보고 v1.2.0 을 발행했지만 태그가 가리키는
// 소스의 실제 버전은 1.1.12 였다. GitHub tag/Release 와 Xcode Cloud 빌드가 먼저 만들어지고,
// Play/AIT 워크플로 내부 exact 검증에서야 expected=1.2.0, aligned=1.1.12 로 중단됐다.
// 그래서 Backoffice 는 외부 write 이전에 "태그가 가리킬 정확한 SHA 의 소스 버전"을 직접 본다.
//
// repo 마다 버전 원장이 다르므로 계약을 SHA 시점의 repo-local 선언으로 판별한다.
// - `scripts/check_release_version.py` 선언 = pinned-source. 세 원장이 서로 같고 태그와도 같아야 한다.
//   (org 재사용 워크플로가 배포 중간에 돌리는 검증과 동일 계약을 Backoffice 가 미리 실행한다.)
// - `scripts/resolve-release-version.mjs` 선언 = tag-derived(org RN 표준). 버전이 태그의 순수 함수라
//   드리프트할 원장 자체가 없다.
// - 둘 다 없으면 tag-derived-caller. Godot caller 가 `version_name` 을 required 입력으로 받고
//   Backoffice 가 그 값을 태그에서 파생해 넘긴다. repo 가 강제하는 pinned 원장이 없다.

/** pinned-source 계약을 선언하는 repo-local 스크립트. */
export const RELEASE_VERSION_CONTRACT_SCRIPT = "scripts/check_release_version.py";
/** org RN 표준의 tag-derived 계약을 선언하는 repo-local 스크립트. */
export const TAG_DERIVED_VERSION_SCRIPT = "scripts/resolve-release-version.mjs";

export const GODOT_PROJECT_PATHS = ["project.godot", "godot/project.godot"] as const;
export const GOOGLE_PLAY_CONFIG_PATH = "play-store/google-play.config.json";
export const APP_STORE_CONFIG_PATH = "app-store/app-store.config.json";

const GODOT_VERSION_RE = /^config\/version="([^"]*)"$/gm;

export type ReleaseSourceContractKind =
  | "pinned-source"
  | "tag-derived"
  | "tag-derived-caller";

export interface ReleaseSourceFiles {
  /** 계약 판별에 쓰는 SHA. 세 원장과 스크립트를 모두 이 SHA 에서 읽어야 한다. */
  sha: string;
  hasContractScript: boolean;
  hasTagDerivedScript: boolean;
  godotProject: { path: string; text: string } | null;
  googlePlay: unknown;
  appStore: unknown;
}

export interface ReleaseSourceContract {
  kind: ReleaseSourceContractKind;
  sha: string;
  tag: string;
  /** 태그에서 파생한 stable SemVer(접두사 v 제외). */
  tagVersion: string;
  /** pinned-source 에서 실제로 읽은 원장 값. 다른 계약에서는 비어 있다. */
  observed: Record<string, string>;
}

/** 외부 write 이전에 확정적으로 막힌 상태. 같은 입력으로 재시도해도 결과가 같다. */
export class ReleaseSourceContractError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "ReleaseSourceContractError";
  }
}

function fail(repoFullName: string, sha: string, detail: string): never {
  throw new ReleaseSourceContractError(
    `${repoFullName}@${sha.slice(0, 7)} 릴리스 소스 검증 실패 — ${detail} ` +
      "태그·Release·배포를 만들지 않고 중단했습니다. 재시도로는 해결되지 않으니 " +
      "소스 버전을 태그와 일치시킨 뒤 다시 릴리스하세요.",
  );
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** project.godot 의 application/config/version. 정확히 하나만 허용한다. */
export function parseGodotConfigVersion(text: string): string {
  const matches = [...text.matchAll(GODOT_VERSION_RE)].map((m) => m[1].trim());
  if (matches.length !== 1) {
    throw new ReleaseSourceContractError(
      `project.godot 의 application/config/version 이 정확히 하나여야 합니다(발견 ${matches.length}개).`,
    );
  }
  return matches[0];
}

function nestedVersion(
  document: unknown,
  path: string,
  keys: readonly string[],
): { value: string } | { missing: string } {
  let cursor = jsonObject(document);
  if (!cursor) return { missing: `${path} 를 읽을 수 없습니다` };
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const next: unknown = cursor[key];
    if (index === keys.length - 1) {
      if (typeof next !== "string" || !next.trim()) {
        return { missing: `${path} 의 ${keys.join(".")} 가 비어 있습니다` };
      }
      return { value: next.trim() };
    }
    const child = jsonObject(next);
    if (!child) return { missing: `${path} 의 ${keys.slice(0, index + 1).join(".")} 가 없습니다` };
    cursor = child;
  }
  return { missing: `${path} 의 ${keys.join(".")} 가 없습니다` };
}

function describe(observed: Record<string, string>): string {
  return Object.entries(observed)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
}

/**
 * 태그가 가리키는 SHA 의 소스 버전 계약을 검증한다. 위반이면 throw 하고, 통과하면 계약 정보를 돌려준다.
 * 호출부는 이 함수가 통과한 뒤에만 GitHub tag/Release, workflow dispatch, Xcode Cloud 실행을 만든다.
 */
export interface ReleaseSourceVersion {
  kind: ReleaseSourceContractKind;
  sha: string;
  /** pinned-source 에서 읽은 단일 소스 버전(접두사 v 제외). 다른 계약에서는 null. */
  sourceVersion: string | null;
  observed: Record<string, string>;
}

/**
 * SHA 의 소스 버전 원장을 읽는다(태그와 비교하지 않는다).
 *
 * 후보 태그를 계산하려면 태그보다 먼저 소스 버전을 알아야 하므로, 원장 읽기와 태그 대조를
 * 분리한다. pinned-source 는 이 단계에서 이미 원장 간 정합(존재·stable SemVer·상호 일치)을
 * 강제하므로, 어긋난 소스는 후보 태그 계산 이전에 fail-closed 된다.
 */
export function readReleaseSourceVersion(input: {
  repoFullName: string;
  files: ReleaseSourceFiles;
}): ReleaseSourceVersion {
  const { repoFullName, files } = input;

  if (!files.hasContractScript) {
    return {
      kind: files.hasTagDerivedScript ? "tag-derived" : "tag-derived-caller",
      sha: files.sha,
      sourceVersion: null,
      observed: {},
    };
  }

  if (!files.godotProject) {
    fail(
      repoFullName,
      files.sha,
      `${RELEASE_VERSION_CONTRACT_SCRIPT} 를 선언했지만 ` +
        `${GODOT_PROJECT_PATHS.join(" 또는 ")} 가 없습니다.`,
    );
  }

  let projectVersion: string;
  try {
    projectVersion = parseGodotConfigVersion(files.godotProject.text);
  } catch (error) {
    fail(repoFullName, files.sha, (error as Error).message);
  }

  const play = nestedVersion(files.googlePlay, GOOGLE_PLAY_CONFIG_PATH, [
    "release",
    "versionName",
  ]);
  const appStore = nestedVersion(files.appStore, APP_STORE_CONFIG_PATH, [
    "release",
    "appleMarketingVersion",
  ]);
  if ("missing" in play) fail(repoFullName, files.sha, `${play.missing}.`);
  if ("missing" in appStore) fail(repoFullName, files.sha, `${appStore.missing}.`);

  const observed: Record<string, string> = {
    [files.godotProject.path]: projectVersion,
    [GOOGLE_PLAY_CONFIG_PATH]: play.value,
    [APP_STORE_CONFIG_PATH]: appStore.value,
  };

  const invalid = Object.entries(observed).filter(
    ([, value]) => parseStableSemVerTag(value) === null,
  );
  if (invalid.length > 0) {
    fail(
      repoFullName,
      files.sha,
      `릴리스 버전은 stable SemVer 여야 합니다: ${describe(Object.fromEntries(invalid))}.`,
    );
  }

  if (new Set(Object.values(observed)).size !== 1) {
    fail(repoFullName, files.sha, `소스 원장 버전이 서로 다릅니다: ${describe(observed)}.`);
  }

  return { kind: "pinned-source", sha: files.sha, sourceVersion: play.value, observed };
}

/**
 * 태그가 가리키는 SHA 의 소스 버전 계약을 검증한다. 위반이면 throw 하고, 통과하면 계약 정보를 돌려준다.
 * 호출부는 이 함수가 통과한 뒤에만 GitHub tag/Release, workflow dispatch, Xcode Cloud 실행을 만든다.
 */
export function assertReleaseSourceContract(input: {
  repoFullName: string;
  tag: string;
  files: ReleaseSourceFiles;
}): ReleaseSourceContract {
  const tag = normalizeStableSemVerTag(input.tag);
  const tagVersion = tag.slice(1);
  const source = readReleaseSourceVersion(input);

  if (source.sourceVersion !== null && source.sourceVersion !== tagVersion) {
    fail(
      input.repoFullName,
      source.sha,
      `태그 버전과 소스 버전이 다릅니다: tag=${tagVersion}, source=${source.sourceVersion} ` +
        `(${describe(source.observed)}).`,
    );
  }

  return {
    kind: source.kind,
    sha: source.sha,
    tag,
    tagVersion,
    observed: source.observed,
  };
}

/**
 * 후보 stable 태그를 확정한다.
 *
 * pinned-source repo 는 소스가 버전 원장을 소유한다. bump 로 원장에 없는 버전을 만들어내면
 * 태그만 앞서가는 상태(v1.2.0 태그 / 소스 1.1.12)가 다시 생기므로, 후보는 항상 소스 버전이다.
 * 버전을 올리려면 repo 에서 원장을 먼저 올려야 한다. 명시 태그가 소스와 다르면 fail-closed 한다.
 *
 * 그 밖의 계약은 버전이 태그의 함수라 대조할 원장이 없다. 기존대로 명시 태그 또는
 * 태그 계보·마켓 원장 중 높은 쪽에서 bump 한다.
 */
export function resolveStableReleaseCandidateTag(input: {
  repoFullName: string;
  source: ReleaseSourceVersion;
  explicitTag?: string;
  bumpedTag: string;
}): { tag: string; bumpIgnored: boolean } {
  const explicitTag = input.explicitTag
    ? normalizeStableSemVerTag(input.explicitTag)
    : null;

  if (input.source.sourceVersion === null) {
    return { tag: explicitTag ?? normalizeStableSemVerTag(input.bumpedTag), bumpIgnored: false };
  }

  const sourceTag = `v${input.source.sourceVersion}`;
  if (explicitTag && explicitTag !== sourceTag) {
    fail(
      input.repoFullName,
      input.source.sha,
      `지정한 태그가 소스 버전과 다릅니다: tag=${explicitTag.slice(1)}, ` +
        `source=${input.source.sourceVersion} (${describe(input.source.observed)}). ` +
        "repo 의 릴리스 버전 원장을 먼저 올린 뒤 그 버전으로 릴리스하세요.",
    );
  }
  return { tag: sourceTag, bumpIgnored: !explicitTag };
}
