import {
  bumpStableSemVerTag,
  compareStableSemVerTags,
  normalizeStableSemVerTag,
  parseStableSemVerTag,
  type Bump,
} from "@/lib/core/stable-semver";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function optionalVersion(value: unknown, source: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error(`${source}가 stable SemVer가 아닙니다: ${String(value)}`);
  }
  const normalized = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.trim())
    ? `${value.trim()}.0`
    : value;
  if (!parseStableSemVerTag(normalized)) {
    throw new Error(`${source}가 stable SemVer가 아닙니다: ${String(value)}`);
  }
  return normalizeStableSemVerTag(normalized);
}

/**
 * repo-local 마켓 config에서 이미 사용 중인 가장 높은 사용자 버전을 읽는다.
 *
 * repo마다 버전 키 위치가 다르다. 최상위 `versionName` / `build.marketingVersion` 만 읽으면
 * `release.*` 구조를 쓰는 repo(lizard-tycoon, lucid-chess, foam-party, babycare)의 floor가
 * 조용히 null 이 되어, 마켓 원장보다 낮은 태그가 가드를 그대로 통과한다.
 * 두 위치를 모두 후보로 넣고 그중 최댓값을 floor로 쓴다.
 */
export function marketVersionFloorFromConfigs(input: {
  googlePlay: unknown;
  appStore: unknown;
}): string | null {
  const play = object(input.googlePlay);
  const playRelease = object(play?.release);
  const appStore = object(input.appStore);
  const appStoreBuild = object(appStore?.build);
  const appStoreRelease = object(appStore?.release);
  const candidates = [
    optionalVersion(play?.versionName, "play-store/google-play.config.json versionName"),
    optionalVersion(
      playRelease?.versionName,
      "play-store/google-play.config.json release.versionName",
    ),
    optionalVersion(
      appStoreBuild?.marketingVersion,
      "app-store/app-store.config.json build.marketingVersion",
    ),
    optionalVersion(
      appStoreRelease?.appleMarketingVersion,
      "app-store/app-store.config.json release.appleMarketingVersion",
    ),
  ].filter((value): value is string => value !== null);

  return candidates.sort((a, b) => compareStableSemVerTags(b, a))[0] ?? null;
}

export function assertTagAtOrAboveMarketFloor(
  tag: string,
  marketFloor: string | null,
): void {
  if (!marketFloor) return;
  const normalized = normalizeStableSemVerTag(tag);
  if (compareStableSemVerTags(normalized, marketFloor) < 0) {
    throw new Error(
      `릴리스 태그 ${normalized}가 마켓 원장 ${marketFloor}보다 낮습니다. ` +
        `${marketFloor} 이상을 직접 지정하거나, 최신 마켓 버전 기준 bump를 사용하세요.`,
    );
  }
}

/** 태그 계보와 마켓 원장 중 높은 쪽을 기준으로 다음 태그를 계산한다. */
export function resolveReleaseTagWithMarketFloor(input: {
  latestTag: string | null;
  marketFloor: string | null;
  explicitTag?: string;
  bump: Bump;
}): string {
  if (input.explicitTag) {
    const tag = normalizeStableSemVerTag(input.explicitTag);
    assertTagAtOrAboveMarketFloor(tag, input.marketFloor);
    return tag;
  }

  const candidates = [input.latestTag, input.marketFloor]
    .filter((value): value is string => Boolean(value))
    .map(normalizeStableSemVerTag);
  const base = candidates.sort((a, b) => compareStableSemVerTags(b, a))[0] ?? null;
  return bumpStableSemVerTag(base, input.bump);
}
