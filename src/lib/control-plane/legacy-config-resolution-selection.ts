import type { LegacyConfigResolutionRequest } from "./contracts";

export type LegacyResolutionReasonCode = LegacyConfigResolutionRequest["dispositions"][number]["reasonCode"];
export type LegacyResolutionTarget = LegacyConfigResolutionRequest["dispositions"][number]["targets"][number];
export type LegacyResolutionDisposition = LegacyConfigResolutionRequest["dispositions"][number];

export const LEGACY_RESOLUTION_BATCH_LIMIT = 25;

export const LEGACY_RESOLUTION_TARGETS_BY_REASON: Record<
  LegacyResolutionReasonCode,
  readonly LegacyResolutionTarget[]
> = {
  UNSUPPORTED_FIELD: [
    "CONFIG_REVISION",
    "BUILD_TARGET",
    "MARKET_LOCALIZATION",
    "COMPLIANCE_PROFILE",
    "PROVIDER_OBSERVATION",
    "STORE_ASSET",
    "EXTERNAL_BINDING",
    "PLATFORM_FLEET_BINDING",
    "CREDENTIAL_BINDING",
    "AUTOMATION_DEFINITION",
    "IGNORED_NON_OPERATIONAL",
  ],
  SECRET_LIKE_KEY: ["CREDENTIAL_BINDING"],
  LEGAL_COMPLIANCE_AMBIGUITY: ["COMPLIANCE_PROFILE"],
  PROVIDER_STATE_AMBIGUITY: ["PROVIDER_OBSERVATION"],
  LOCALIZATION_LOCALE_MISSING: ["CONFIG_REVISION", "MARKET_LOCALIZATION"],
  FREE_TEXT_REQUIRES_INPUT: ["CONFIG_REVISION", "MARKET_LOCALIZATION"],
  CONFLICTING_DESIRED_STATE: ["CONFIG_REVISION"],
  NO_REPRESENTABLE_SOURCE: ["CONFIG_REVISION", "IGNORED_NON_OPERATIONAL"],
};

export function suggestedLegacyResolutionTargets(
  reasonCode: LegacyResolutionReasonCode,
  availableEvidenceKinds: ReadonlySet<LegacyResolutionTarget>,
): LegacyResolutionTarget[] {
  if (reasonCode === "NO_REPRESENTABLE_SOURCE") return ["IGNORED_NON_OPERATIONAL"];
  if (reasonCode === "UNSUPPORTED_FIELD") {
    const concrete = LEGACY_RESOLUTION_TARGETS_BY_REASON[reasonCode].filter((target) => (
      target !== "IGNORED_NON_OPERATIONAL"
      && target !== "CONFIG_REVISION"
      && availableEvidenceKinds.has(target)
    ));
    return concrete.length > 0 ? concrete : ["CONFIG_REVISION"];
  }
  const preferred = LEGACY_RESOLUTION_TARGETS_BY_REASON[reasonCode].find((target) => (
    target === "IGNORED_NON_OPERATIONAL" || availableEvidenceKinds.has(target)
  ));
  return preferred ? [preferred] : [];
}

export function suggestedLegacyResolutionDispositions(input: {
  reasonCodes: readonly LegacyResolutionReasonCode[];
  availableEvidenceKinds: readonly LegacyResolutionTarget[];
}): LegacyResolutionDisposition[] {
  const available = new Set(input.availableEvidenceKinds);
  return input.reasonCodes.map((reasonCode) => ({
    reasonCode,
    targets: suggestedLegacyResolutionTargets(reasonCode, available),
  }));
}

export function missingLegacyResolutionEvidenceKinds(
  dispositions: readonly LegacyResolutionDisposition[],
): LegacyResolutionTarget[] {
  return [...new Set(dispositions.flatMap((disposition) => (
    disposition.targets.length > 0
      ? []
      : LEGACY_RESOLUTION_TARGETS_BY_REASON[disposition.reasonCode].filter(
          (target) => target !== "IGNORED_NON_OPERATIONAL",
        )
  )))].sort();
}

export function legacyResolutionJustification(
  dispositions: readonly LegacyResolutionDisposition[],
): LegacyConfigResolutionRequest["justification"] {
  const ignored = dispositions.some((disposition) => (
    disposition.targets.includes("IGNORED_NON_OPERATIONAL")
  ));
  const noLegacyDesiredState = dispositions.length === 1
    && dispositions[0]?.reasonCode === "NO_REPRESENTABLE_SOURCE"
    && dispositions[0].targets.length === 1
    && dispositions[0].targets[0] === "IGNORED_NON_OPERATIONAL";
  return noLegacyDesiredState
    ? "NO_LEGACY_DESIRED_STATE"
    : ignored
      ? "IGNORED_NON_OPERATIONAL_REVIEWED"
      : "CENTRAL_STATE_REVIEWED";
}

export function nextLegacyResolutionTargets(
  current: readonly LegacyResolutionTarget[],
  target: LegacyResolutionTarget,
): LegacyResolutionTarget[] {
  if (target === "IGNORED_NON_OPERATIONAL") {
    return current.includes(target) ? [] : [target];
  }

  const values = new Set(current.filter((value) => value !== "IGNORED_NON_OPERATIONAL"));
  if (values.has(target)) values.delete(target);
  else values.add(target);
  return [...values].sort();
}
