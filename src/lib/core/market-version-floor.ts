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

/**
 * 태그 계보와 마켓 원장 중 높은 쪽을 기준으로 다음 태그를 **추천**한다.
 *
 * 마켓 원장은 이미 배포된 버전이라 "그 이상"이라는 사실이 태그가 가리키는 소스의 버전을 보증하지
 * 못한다(v1.2.0 태그 / 소스 1.1.12 장애). 그래서 floor 는 추천에만 쓰고, 명시 태그는 그대로 쓴다.
 * 실제 릴리스·배포 허가는 `assertReleaseSourceContract` 가 SHA 단위로 판단한다.
 */
export function resolveReleaseTagWithMarketFloor(input: {
  latestTag: string | null;
  marketFloor: string | null;
  explicitTag?: string;
  bump: Bump;
}): string {
  if (input.explicitTag) return normalizeStableSemVerTag(input.explicitTag);

  const candidates = [input.latestTag, input.marketFloor]
    .filter((value): value is string => Boolean(value))
    .map(normalizeStableSemVerTag);
  const base = candidates.sort((a, b) => compareStableSemVerTags(b, a))[0] ?? null;
  return bumpStableSemVerTag(base, input.bump);
}
