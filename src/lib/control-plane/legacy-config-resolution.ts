import type {
  LegacyConfigResolutionRequest,
} from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  compareResolvedLegacySubset,
  type LegacyShadowParity,
  type LegacyTransformReasonCode,
  type LegacyTransformResult,
} from "@/lib/control-plane/legacy-shadow";

export type LegacyResolutionApprovalKind = "HUMAN" | "AUTOMATION";

export type LegacyResolutionDisposition = LegacyConfigResolutionRequest["dispositions"][number];

export type LegacyResolutionBinding = {
  id: string;
  appId: string;
  sourceSha: string;
  transformVersion: string;
  inputDigest: string;
  reasonCodesDigest: string;
  configRevisionId: string;
  centralStateDigest: string;
  resolutionDigest: string;
};

const RESOLVABLE_REASON_CODES = new Set<LegacyTransformReasonCode>([
  "UNSUPPORTED_FIELD",
  "SECRET_LIKE_KEY",
  "LEGAL_COMPLIANCE_AMBIGUITY",
  "PROVIDER_STATE_AMBIGUITY",
  "LOCALIZATION_LOCALE_MISSING",
  "FREE_TEXT_REQUIRES_INPUT",
  "CONFLICTING_DESIRED_STATE",
  "NO_REPRESENTABLE_SOURCE",
]);

const TARGETS_BY_REASON = new Map<LegacyTransformReasonCode, ReadonlySet<LegacyResolutionDisposition["targets"][number]>>([
  ["UNSUPPORTED_FIELD", new Set([
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
  ])],
  ["SECRET_LIKE_KEY", new Set(["CREDENTIAL_BINDING"])],
  ["LEGAL_COMPLIANCE_AMBIGUITY", new Set(["COMPLIANCE_PROFILE"])],
  ["PROVIDER_STATE_AMBIGUITY", new Set(["PROVIDER_OBSERVATION"])],
  ["LOCALIZATION_LOCALE_MISSING", new Set(["CONFIG_REVISION", "MARKET_LOCALIZATION"])],
  ["FREE_TEXT_REQUIRES_INPUT", new Set(["CONFIG_REVISION", "MARKET_LOCALIZATION"])],
  ["CONFLICTING_DESIRED_STATE", new Set(["CONFIG_REVISION"])],
  ["NO_REPRESENTABLE_SOURCE", new Set(["CONFIG_REVISION", "IGNORED_NON_OPERATIONAL"])],
]);

export function legacyResolutionReasonCodes(
  transform: LegacyTransformResult,
): LegacyTransformReasonCode[] {
  if (transform.status === "DRAFTABLE") return [];
  return [...new Set(transform.reasons.map((reason) => reason.code))].sort();
}

export function legacyResolutionReasonCodesDigest(reasonCodes: readonly string[]): string {
  return jsonDigest({
    scope: "legacy-config-resolution-reasons/v1",
    reasonCodes: [...new Set(reasonCodes)].sort(),
  } as JsonValue);
}

export function validateLegacyResolutionDispositions(input: {
  reasonCodes: readonly LegacyTransformReasonCode[];
  dispositions: readonly LegacyResolutionDisposition[];
  evidenceKinds: ReadonlySet<LegacyResolutionDisposition["targets"][number]>;
  approvalKind: LegacyResolutionApprovalKind;
}): { ok: true } | { ok: false; code: string } {
  const reasonCodes = [...new Set(input.reasonCodes)].sort();
  if (reasonCodes.length === 0 || reasonCodes.some((code) => !RESOLVABLE_REASON_CODES.has(code))) {
    return { ok: false, code: "LEGACY_RESOLUTION_REASON_NOT_RESOLVABLE" };
  }
  const resolvableReasonCodes = reasonCodes as LegacyResolutionDisposition["reasonCode"][];
  const dispositions = new Map(input.dispositions.map((item) => [item.reasonCode, item.targets]));
  if (
    dispositions.size !== input.dispositions.length
    || dispositions.size !== resolvableReasonCodes.length
    || resolvableReasonCodes.some((code) => !dispositions.has(code))
    || [...dispositions.keys()].some((code) => !resolvableReasonCodes.includes(code))
  ) {
    return { ok: false, code: "LEGACY_RESOLUTION_DISPOSITION_INCOMPLETE" };
  }
  if (input.approvalKind === "AUTOMATION" && (
    resolvableReasonCodes.length !== 1
    || resolvableReasonCodes[0] !== "NO_REPRESENTABLE_SOURCE"
    || dispositions.get("NO_REPRESENTABLE_SOURCE")?.length !== 1
    || dispositions.get("NO_REPRESENTABLE_SOURCE")?.[0] !== "IGNORED_NON_OPERATIONAL"
  )) {
    return { ok: false, code: "LEGACY_RESOLUTION_HUMAN_APPROVAL_REQUIRED" };
  }
  for (const reasonCode of resolvableReasonCodes) {
    const targets = dispositions.get(reasonCode)!;
    for (const target of targets) {
      if (!TARGETS_BY_REASON.get(reasonCode)?.has(target)) {
        return { ok: false, code: "LEGACY_RESOLUTION_TARGET_INVALID" };
      }
      if (target !== "IGNORED_NON_OPERATIONAL" && !input.evidenceKinds.has(target)) {
        return { ok: false, code: "LEGACY_RESOLUTION_EVIDENCE_MISSING" };
      }
      if (target === "IGNORED_NON_OPERATIONAL" && input.approvalKind !== "HUMAN" && reasonCode !== "NO_REPRESENTABLE_SOURCE") {
        return { ok: false, code: "LEGACY_RESOLUTION_HUMAN_APPROVAL_REQUIRED" };
      }
    }
  }
  return { ok: true };
}

export function applyLegacyConfigResolution(input: {
  transform: LegacyTransformResult;
  persistedInputDigest: string;
  sourceSha: string;
  configRevisionId: string;
  centralPayload: unknown;
  centralStateDigest: string;
  resolution: LegacyResolutionBinding | null;
}): LegacyShadowParity | null {
  const resolution = input.resolution;
  if (!resolution || input.transform.coverage.status !== "COMPLETE") return null;
  const reasonCodes = legacyResolutionReasonCodes(input.transform);
  const reasonCodesDigest = legacyResolutionReasonCodesDigest(reasonCodes);
  if (
    resolution.sourceSha !== input.sourceSha
    || resolution.transformVersion !== input.transform.transformVersion
    || resolution.inputDigest !== input.persistedInputDigest
    || resolution.reasonCodesDigest !== reasonCodesDigest
    || resolution.configRevisionId !== input.configRevisionId
    || resolution.centralStateDigest !== input.centralStateDigest
  ) return null;
  const representableParity = compareResolvedLegacySubset(input.transform, input.centralPayload);
  if (representableParity.status !== "MATCH") return representableParity;
  const parityDigest = jsonDigest({
    scope: "legacy-config-resolution-parity/v1",
    appId: resolution.appId,
    sourceSha: input.sourceSha,
    transformVersion: input.transform.transformVersion,
    inputDigest: input.persistedInputDigest,
    reasonCodesDigest,
    configRevisionId: input.configRevisionId,
    centralStateDigest: input.centralStateDigest,
    resolutionDigest: resolution.resolutionDigest,
  } as JsonValue);
  return {
    status: "MATCH",
    transformVersion: input.transform.transformVersion,
    inputDigest: input.persistedInputDigest,
    coverage: input.transform.coverage,
    legacyDigest: parityDigest,
    centralDigest: parityDigest,
    diffs: [],
  };
}
