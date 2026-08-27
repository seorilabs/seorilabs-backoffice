export const LEGACY_TRANSFORM_VERSION = "legacy-config-v1" as const;

export const LEGACY_SOURCE_DEFINITIONS = [
  {
    sourceKind: "GOOGLE_PLAY_CONFIG",
    repositoryScope: "APP",
    pathPattern: "play-store/google-play.config.json",
    format: "JSON",
  },
  {
    sourceKind: "APP_STORE_CONFIG",
    repositoryScope: "APP",
    pathPattern: "app-store/app-store.config.json",
    format: "JSON",
  },
  {
    sourceKind: "APPS_IN_TOSS_CONFIG",
    repositoryScope: "APP",
    pathPattern: "apps-in-toss/apps-in-toss.config.json",
    format: "JSON",
  },
  {
    sourceKind: "MARKET_LAUNCH_STATE",
    repositoryScope: "APP",
    pathPattern: "release/market-launch-state.json",
    format: "JSON",
  },
  {
    sourceKind: "PLATFORM_APP_REGISTRY",
    repositoryScope: "PLATFORM",
    pathPattern: "registry/apps/*.json",
    format: "JSON",
  },
  {
    sourceKind: "SEORILABS_APP_YAML",
    repositoryScope: "APP",
    pathPattern: ".seorilabs/app.yaml",
    format: "YAML",
  },
  {
    sourceKind: "SEORILABS_BACKOFFICE_JSON",
    repositoryScope: "APP",
    pathPattern: ".seorilabs/backoffice.json",
    format: "JSON",
  },
] as const;

export type LegacySourceDefinition = (typeof LEGACY_SOURCE_DEFINITIONS)[number];
export type LegacySourceKind = LegacySourceDefinition["sourceKind"];
export type LegacySourceRepositoryScope = LegacySourceDefinition["repositoryScope"];
export type LegacySourceReadStatus = "PRESENT" | "ABSENT" | "UNREADABLE";

export type LegacySourceInput = {
  sourceKind: LegacySourceKind;
  repository: string;
  sourceSha: string;
  path: string;
  status: LegacySourceReadStatus;
  /** Reader가 메모리에서 넘기는 일시적 원문이다. 결과나 오류에는 포함되지 않는다. */
  text?: string;
};

const SOURCE_BY_KIND = new Map<LegacySourceKind, LegacySourceDefinition>(
  LEGACY_SOURCE_DEFINITIONS.map((definition) => [definition.sourceKind, definition]),
);

export function legacySourceDefinition(sourceKind: LegacySourceKind): LegacySourceDefinition {
  const definition = SOURCE_BY_KIND.get(sourceKind);
  if (!definition) throw new Error("허용되지 않은 legacy source kind입니다.");
  return definition;
}

export function normalizeLegacySourcePath(path: string): string | null {
  if (path.includes("\\")) return null;
  const normalized = path.replace(/^\.\//, "");
  if (
    normalized.length === 0
    || normalized.startsWith("/")
    || normalized.endsWith("/")
    || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
}

export function matchesLegacySourcePath(sourceKind: LegacySourceKind, path: string): boolean {
  const normalized = normalizeLegacySourcePath(path);
  if (!normalized) return false;
  const definition = legacySourceDefinition(sourceKind);
  if (definition.sourceKind !== "PLATFORM_APP_REGISTRY") {
    return normalized === definition.pathPattern;
  }
  return /^registry\/apps\/[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.json$/.test(normalized);
}
