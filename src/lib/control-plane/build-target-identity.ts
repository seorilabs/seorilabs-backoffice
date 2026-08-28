export const BUILD_TARGET_MARKETS = [
  "google-play",
  "app-store",
  "apps-in-toss",
] as const;

export type BuildTargetMarket = typeof BUILD_TARGET_MARKETS[number];

export interface PublicBuildTargetFact {
  market: string | null;
  packageId: string | null;
  bundleId: string | null;
  configuration: unknown;
}

export interface PublicExternalBindingFact {
  provider: string;
  bindingType: string;
  externalId: string;
  publicIdentity: string | null;
}

export type ExactBuildTargetIdentity =
  | {
      status: "READY";
      target: PublicBuildTargetFact;
      publicIdentity: string;
      resolvedBy: "SOURCE" | "SOURCE_AND_EXTERNAL_BINDING" | "EXTERNAL_BINDING";
    }
  | {
      status:
        | "TARGET_MISSING"
        | "TARGET_AMBIGUOUS"
        | "IDENTITY_MISSING"
        | "EXTERNAL_BINDING_AMBIGUOUS"
        | "EXTERNAL_BINDING_INVALID"
        | "IDENTITY_CONFLICT";
    };

const APPLICATION_BINDING_TYPE = {
  "google-play": "application",
  "app-store": "application",
  "apps-in-toss": "mini-app",
} as const satisfies Record<BuildTargetMarket, string>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function appsInTossAppName(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) return null;
  return nonEmptyString((configuration as Record<string, unknown>).appName);
}

/**
 * exact source SHA에 같은 market target이 하나 있고 공개 build identity가 source 또는
 * provider의 exact application/mini-app binding으로 유일하게 관측된 경우만
 * release/resolved-manifest 경계가 사용할 수 있다. nullable discovery fact를 임의 App
 * legacy 값이나 account/team/workspace binding으로 채우지 않는다.
 */
export function exactBuildTargetIdentity(
  targets: readonly PublicBuildTargetFact[],
  market: BuildTargetMarket,
  externalBindings: readonly PublicExternalBindingFact[] = [],
): ExactBuildTargetIdentity {
  const matches = targets.filter((target) => target.market === market);
  if (matches.length === 0) return { status: "TARGET_MISSING" };
  if (matches.length > 1) return { status: "TARGET_AMBIGUOUS" };
  const target = matches[0];
  const sourceIdentity = market === "google-play"
    ? nonEmptyString(target.packageId)
    : market === "app-store"
      ? nonEmptyString(target.bundleId)
      : appsInTossAppName(target.configuration);
  const applicationBindings = externalBindings.filter((binding) => (
    binding.provider === market
    && binding.bindingType === APPLICATION_BINDING_TYPE[market]
  ));
  if (applicationBindings.length > 1) return { status: "EXTERNAL_BINDING_AMBIGUOUS" };
  const applicationBinding = applicationBindings[0];
  if (!applicationBinding) {
    return sourceIdentity
      ? { status: "READY", target, publicIdentity: sourceIdentity, resolvedBy: "SOURCE" }
      : { status: "IDENTITY_MISSING" };
  }
  const bindingResourceId = nonEmptyString(applicationBinding.externalId);
  const bindingIdentity = nonEmptyString(applicationBinding.publicIdentity);
  // market application/mini-app binding은 provider resource ID 자체가 공개 build
  // identity인 계약만 허용한다. account/team/workspace ID를 application으로 잘못
  // 투영하거나 public identity만 덮어쓴 generic binding은 fallback이 될 수 없다.
  if (!bindingResourceId || !bindingIdentity || bindingResourceId !== bindingIdentity) {
    return { status: "EXTERNAL_BINDING_INVALID" };
  }
  if (sourceIdentity && sourceIdentity !== bindingIdentity) {
    return { status: "IDENTITY_CONFLICT" };
  }
  return {
    status: "READY",
    target,
    publicIdentity: sourceIdentity ?? bindingIdentity,
    resolvedBy: sourceIdentity ? "SOURCE_AND_EXTERNAL_BINDING" : "EXTERNAL_BINDING",
  };
}
