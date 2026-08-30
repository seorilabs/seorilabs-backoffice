import {
  compareStableSemVerTags,
  normalizeStableSemVerTag,
  parseStableSemVerTag,
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
