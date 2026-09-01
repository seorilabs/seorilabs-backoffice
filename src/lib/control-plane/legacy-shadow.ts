import crypto from "node:crypto";
import { parse as parseYaml, parseDocument as parseYamlDocument } from "yaml";
import type { z } from "zod";

import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";
import {
  LEGACY_SOURCE_DEFINITIONS,
  LEGACY_TRANSFORM_VERSION,
  legacySourceDefinition,
  matchesLegacySourcePath,
  normalizeLegacySourcePath,
  type LegacySourceInput,
  type LegacySourceKind,
} from "@/lib/control-plane/legacy-sources";

export type DraftableConfigRevisionPayload = z.infer<typeof configRevisionPayloadSchema>;

export type LegacyTransformReasonCode =
  | "PARTIAL_CROSS_REPO_VECTOR"
  | "SOURCE_KIND_NOT_ALLOWED"
  | "DUPLICATE_SOURCE"
  | "SOURCE_PATH_MISMATCH"
  | "SOURCE_PROVENANCE_INVALID"
  | "SOURCE_STATUS_INVALID"
  | "SOURCE_UNREADABLE"
  | "SOURCE_CONTENT_MISSING"
  | "SOURCE_CONTENT_UNEXPECTED"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_PARSE_ERROR"
  | "SOURCE_NOT_OBJECT"
  | "INVALID_SOURCE_SHAPE"
  | "UNSUPPORTED_FIELD"
  | "SECRET_LIKE_KEY"
  | "LEGAL_COMPLIANCE_AMBIGUITY"
  | "PROVIDER_STATE_AMBIGUITY"
  | "LOCALIZATION_LOCALE_MISSING"
  | "FREE_TEXT_REQUIRES_INPUT"
  | "CONFLICTING_DESIRED_STATE"
  | "NO_REPRESENTABLE_SOURCE"
  | "INVALID_DESIRED_STATE";

export type LegacyTransformReason = {
  code: LegacyTransformReasonCode;
  sourceKind?: LegacySourceKind;
  path: string;
};

export type LegacyTransformCoverage = {
  status: "COMPLETE" | "PARTIAL";
  expected: number;
  reported: number;
  present: number;
  absent: number;
  readable: number;
  transformable: number;
  blocked: number;
};

type LegacyTransformCommon = {
  transformVersion: typeof LEGACY_TRANSFORM_VERSION;
  inputDigest: string;
  coverage: LegacyTransformCoverage;
};

export type LegacyTransformResult =
  | (LegacyTransformCommon & {
    status: "DRAFTABLE";
    payload: DraftableConfigRevisionPayload;
    payloadDigest: string;
    reasons: [];
  })
  | (LegacyTransformCommon & {
    status: "DRAFTABLE_WITH_INPUT";
    payload: DraftableConfigRevisionPayload;
    payloadDigest: string;
    reasons: LegacyTransformReason[];
  })
  | (LegacyTransformCommon & {
    status: "NEEDS_INPUT";
    payload?: never;
    payloadDigest: null;
    reasons: LegacyTransformReason[];
  });

export type LegacyParityDiffCode =
  | "PARTIAL_COVERAGE"
  | "TRANSFORM_NEEDS_INPUT"
  | "TARGET_INVALID"
  | "MISSING_IN_LEGACY"
  | "MISSING_IN_CENTRAL"
  | "TYPE_MISMATCH"
  | "VALUE_MISMATCH"
  | "ARRAY_LENGTH_MISMATCH";

export type LegacyParityDiff = {
  path: string;
  code: LegacyParityDiffCode;
};

export type LegacyShadowParity = {
  status: "MATCH" | "MISMATCH" | "NEEDS_INPUT";
  transformVersion: typeof LEGACY_TRANSFORM_VERSION;
  inputDigest: string;
  coverage: LegacyTransformCoverage;
  legacyDigest: string | null;
  centralDigest: string | null;
  diffs: LegacyParityDiff[];
};

const MAX_SOURCE_BYTES = 1_000_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LEGACY_BACKOFFICE_TOOL_MANIFEST_SCHEMA =
  "https://raw.githubusercontent.com/seorilabs/seorilabs-backoffice/main/docs/app-ops/manifest.schema.json";

const SECRET_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authtoken",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "key",
  "password",
  "passwd",
  "privatekey",
  "recoverycode",
  "refreshtoken",
  "secret",
  "serviceaccountjson",
  "sessioncookie",
  "signingkey",
  "totp",
]);

const LEGAL_KEYS = new Set([
  "agerating",
  "appprivacy",
  "banking",
  "businessregistration",
  "compliance",
  "contentdeclarations",
  "contentrating",
  "contract",
  "datasafety",
  "digitalservicesact",
  "exportcompliance",
  "legal",
  "privacyanswers",
  "tax",
  "targetaudience",
  "terms",
]);

const PROVIDER_STATE_KEYS = new Set([
  "approval",
  "deploymentapproval",
  "gates",
  "processing",
  "providerstate",
  "publicstate",
  "release",
  "review",
  "rollout",
  "state",
  "status",
  "submission",
  "targettrack",
  "track",
]);

const CREDENTIAL_OBSERVATION_KEYS = new Set([
  "evidence",
  "loginSmoke",
  "reference",
  "status",
  "verifiedAt",
]);

const MARKET_ORDER = new Map([
  ["google-play", 0],
  ["app-store", 1],
  ["apps-in-toss", 2],
]);

/**
 * 이 사유들은 source vector 자체가 불완전하거나 모호하다는 뜻이 아니다.
 * 해당 값만 ConfigRevision 밖의 중앙 모델 또는 사람 입력으로 분리하고, 이미
 * 안전하게 구조화된 market/build 값은 검토용 DRAFT로 제공할 수 있다.
 * DRAFTABLE_WITH_INPUT은 parity/cleanup을 계속 차단하고 직접 활성화도 금지된다.
 */
const REVIEWABLE_REASON_CODES = new Set<LegacyTransformReasonCode>([
  "UNSUPPORTED_FIELD",
  "SECRET_LIKE_KEY",
  "LEGAL_COMPLIANCE_AMBIGUITY",
  "PROVIDER_STATE_AMBIGUITY",
  "LOCALIZATION_LOCALE_MISSING",
  "FREE_TEXT_REQUIRES_INPUT",
  "NO_REPRESENTABLE_SOURCE",
]);

function isBlockingReason(reason: LegacyTransformReason): boolean {
  return !REVIEWABLE_REASON_CODES.has(reason.code);
}

type MutablePayload = {
  markets: Map<string, DraftableConfigRevisionPayload["markets"][number]>;
  localizations: Map<string, NonNullable<DraftableConfigRevisionPayload["localizations"]>[number]>;
  assets: NonNullable<DraftableConfigRevisionPayload["assets"]>;
  build: NonNullable<DraftableConfigRevisionPayload["build"]>;
  support: NonNullable<DraftableConfigRevisionPayload["support"]>;
};

type TransformContext = {
  draft: MutablePayload;
  reasons: LegacyTransformReason[];
  transformableKinds: Set<LegacySourceKind>;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretLikeKey(key: string): boolean {
  return SECRET_KEYS.has(key)
    || /(?:password|passwd|secret|tokens?|privatekey|credentials?|cookie|totp|recoverycodes?)$/.test(key);
}

/**
 * legacy schema에서 `key`가 credential이 아니라 공개 식별자로 정의된 경로만 예외로 둔다.
 * 일반 `key`는 계속 secret carrier로 취급해 새롭거나 오염된 shape를 fail-closed한다.
 */
function isKnownPublicIdentifierKey(sourceKind: LegacySourceKind, path: string): boolean {
  if (sourceKind === "PLATFORM_APP_REGISTRY") {
    return /^\$\.ads\.placements\[\d+\]\.reward\.key$/.test(path);
  }
  if (sourceKind !== "SEORILABS_BACKOFFICE_JSON") return false;
  if (/^\$\.tools\[\d+\]\.operations\[\d+\]\.inputs\[\d+\]\.key$/.test(path)) return true;
  return /^\$\.analytics\.content\.(?:market\.values|metrics|derived|distributions|groups)\[\d+\](?:\.(?:metrics|derived)\[\d+\])?\.key$/.test(path);
}

/**
 * 일부 구형 market JSON의 review.credentials는 자격증명 값이 아니라 사람 로그인
 * 점검의 공개 상태 envelope다. 이 고정 shape만 parent key 오탐에서 제외하고,
 * 내부는 계속 재귀 스캔하므로 password/token 같은 실제 필드는 그대로 차단된다.
 */
function isCredentialObservationEnvelope(value: unknown, depth = 0): boolean {
  if (depth > 64 || !isRecord(value) || Object.keys(value).length === 0) return false;
  return Object.entries(value).every(([key, nested]) => {
    if (!CREDENTIAL_OBSERVATION_KEYS.has(key)) return false;
    if (key === "loginSmoke") {
      return nested === null || isCredentialObservationEnvelope(nested, depth + 1);
    }
    return nested === null || ["string", "number", "boolean"].includes(typeof nested);
  });
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function issuePath(path: Array<PropertyKey>): string {
  return path.length === 0 ? "$" : `$.${path.map(String).join(".")}`;
}

function addReason(
  reasons: LegacyTransformReason[],
  code: LegacyTransformReasonCode,
  path: string,
  sourceKind?: LegacySourceKind,
): void {
  reasons.push({ code, sourceKind, path });
}

function scanForbiddenKeys(
  value: unknown,
  sourceKind: LegacySourceKind,
  reasons: LegacyTransformReason[],
  path = "$",
  depth = 0,
): void {
  if (depth > 64) {
    addReason(reasons, "INVALID_SOURCE_SHAPE", path, sourceKind);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenKeys(item, sourceKind, reasons, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const keyPath = childPath(path, key);
    const normalized = normalizedKey(key);
    if (
      isSecretLikeKey(normalized)
      && !(normalized === "key" && isKnownPublicIdentifierKey(sourceKind, keyPath))
      && !(
        keyPath === "$.review.credentials"
        && normalized === "credentials"
        && isCredentialObservationEnvelope(nested)
      )
    ) {
      addReason(reasons, "SECRET_LIKE_KEY", keyPath, sourceKind);
    }
    if (
      LEGAL_KEYS.has(normalized)
      || normalized.endsWith("rating")
      || normalized.endsWith("classification")
      || normalized.endsWith("declaration")
    ) {
      addReason(reasons, "LEGAL_COMPLIANCE_AMBIGUITY", keyPath, sourceKind);
    }
    if (
      PROVIDER_STATE_KEYS.has(normalized)
      || normalized.endsWith("status")
      || normalized.endsWith("state")
    ) {
      addReason(reasons, "PROVIDER_STATE_AMBIGUITY", keyPath, sourceKind);
    }
    scanForbiddenKeys(nested, sourceKind, reasons, keyPath, depth + 1);
  }
}

function assertAllowedKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  sourceKind: LegacySourceKind,
  reasons: LegacyTransformReason[],
  path: string,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    addReason(reasons, "INVALID_SOURCE_SHAPE", path, sourceKind);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addReason(reasons, "UNSUPPORTED_FIELD", childPath(path, key), sourceKind);
  }
  return true;
}

function parseSource(source: LegacySourceInput, reasons: LegacyTransformReason[]): Record<string, unknown> | null {
  if (source.status !== "PRESENT") return null;
  if (typeof source.text !== "string") {
    addReason(reasons, "SOURCE_CONTENT_MISSING", "$", source.sourceKind);
    return null;
  }
  if (Buffer.byteLength(source.text, "utf8") > MAX_SOURCE_BYTES) {
    addReason(reasons, "SOURCE_TOO_LARGE", "$", source.sourceKind);
    return null;
  }
  let parsed: unknown;
  try {
    if (legacySourceDefinition(source.sourceKind).format === "YAML") {
      parsed = parseYaml(source.text);
    } else {
      // JSON.parse는 중복 object key를 마지막 값으로 조용히 덮어쓴다. parser별
      // 의미가 갈리는 legacy 원문을 중앙 desired state로 추측해 옮기지 않는다.
      const document = parseYamlDocument(source.text, {
        schema: "json",
        strict: true,
        uniqueKeys: true,
      });
      if (document.errors.length > 0) throw new Error("ambiguous JSON document");
      parsed = JSON.parse(source.text);
    }
  } catch {
    addReason(reasons, "SOURCE_PARSE_ERROR", "$", source.sourceKind);
    return null;
  }
  if (!isRecord(parsed)) {
    addReason(reasons, "SOURCE_NOT_OBJECT", "$", source.sourceKind);
    return null;
  }
  scanForbiddenKeys(parsed, source.sourceKind, reasons);
  return parsed;
}

function mergeScalar<T extends string | number | boolean>(
  target: Record<string, unknown>,
  key: string,
  value: T | undefined,
  sourceKind: LegacySourceKind,
  reasons: LegacyTransformReason[],
  path: string,
): void {
  if (value === undefined) return;
  const current = target[key];
  if (current !== undefined && current !== value) {
    addReason(reasons, "CONFLICTING_DESIRED_STATE", path, sourceKind);
    return;
  }
  target[key] = value;
}

function readOptionalString(
  value: unknown,
  sourceKind: LegacySourceKind,
  reasons: LegacyTransformReason[],
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    addReason(reasons, "INVALID_SOURCE_SHAPE", path, sourceKind);
    return undefined;
  }
  return value;
}

function readOptionalBoolean(
  value: unknown,
  sourceKind: LegacySourceKind,
  reasons: LegacyTransformReason[],
  path: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    addReason(reasons, "INVALID_SOURCE_SHAPE", path, sourceKind);
    return undefined;
  }
  return value;
}

function readLocalizedStrings(
  value: unknown,
  sourceKind: LegacySourceKind,
  reasons: LegacyTransformReason[],
  path: string,
  fallbackLocale?: string,
): Map<string, string> {
  const result = new Map<string, string>();
  if (value === undefined) return result;
  if (typeof value === "string" && fallbackLocale) {
    result.set(fallbackLocale, value);
    return result;
  }
  if (!isRecord(value)) {
    addReason(reasons, "INVALID_SOURCE_SHAPE", path, sourceKind);
    return result;
  }
  for (const [locale, text] of Object.entries(value)) {
    if (typeof text !== "string") {
      addReason(reasons, "INVALID_SOURCE_SHAPE", childPath(path, locale), sourceKind);
      continue;
    }
    result.set(locale, text);
  }
  return result;
}

function mergeLocalization(
  context: TransformContext,
  locale: string,
  field: "displayName" | "subtitle" | "description" | "keywords",
  _value: string | string[],
  sourceKind: LegacySourceKind,
): void {
  // 자유 텍스트는 public metadata처럼 보여도 credential canary를 구분할 수 없다.
  // Catalog-aware detector가 도입되기 전에는 사람이 같은 중앙 UI/API로 입력한다.
  addReason(context.reasons, "FREE_TEXT_REQUIRES_INPUT", `$.localizations.${locale}.${field}`, sourceKind);
}

function mergeMarket(
  context: TransformContext,
  market: "google-play" | "app-store" | "apps-in-toss",
  enabled: boolean,
  locales: Iterable<string>,
  sourceKind: LegacySourceKind,
): void {
  const sortedLocales = [...new Set(locales)].sort(compareText);
  const releaseChannel = enabled
    ? ({ "google-play": "internal", "app-store": "testflight", "apps-in-toss": "private" } as const)[market]
    : undefined;
  const existing = context.draft.markets.get(market);
  if (existing && (
    existing.enabled !== enabled
    || existing.releaseChannel !== releaseChannel
    || JSON.stringify([...existing.locales].sort(compareText)) !== JSON.stringify(sortedLocales)
  )) {
    addReason(context.reasons, "CONFLICTING_DESIRED_STATE", `$.markets.${market}`, sourceKind);
    return;
  }
  context.draft.markets.set(market, {
    market,
    enabled,
    locales: sortedLocales,
    ...(releaseChannel ? { releaseChannel } : {}),
  });
}

function transformBuild(
  context: TransformContext,
  value: unknown,
  sourceKind: LegacySourceKind,
  path: string,
  allowLegacyScalar = false,
): void {
  if (value === undefined) return;
  if (typeof value === "string" && allowLegacyScalar) {
    // 초기 App Store 설정은 archive/build 표식을 scalar로 기록했다. 값을
    // ConfigRevision으로 추측해 옮기지 않고 BuildTarget 사람 검토로 분리한다.
    addReason(context.reasons, "UNSUPPORTED_FIELD", path, sourceKind);
    addReason(context.reasons, "FREE_TEXT_REQUIRES_INPUT", path, sourceKind);
    return;
  }
  const allowed = new Set(["workflowBundleSha", "workflowBundleDigest", "platformVersion", "minSdk", "targetSdk"]);
  if (!assertAllowedKeys(value, allowed, sourceKind, context.reasons, path)) return;
  for (const key of ["workflowBundleSha", "workflowBundleDigest", "platformVersion"] as const) {
    const item = readOptionalString(value[key], sourceKind, context.reasons, `${path}.${key}`);
    if (item !== undefined) {
      // 형식상 SHA/SemVer여도 임의 문자열을 secret carrier로 쓸 수 있다. 승인된
      // WorkflowBundle/Platform release 원장과 대조하기 전에는 자동 이관하지 않는다.
      addReason(context.reasons, "FREE_TEXT_REQUIRES_INPUT", `${path}.${key}`, sourceKind);
    }
  }
  for (const key of ["minSdk", "targetSdk"] as const) {
    const item = value[key];
    if (item !== undefined && (typeof item !== "number" || !Number.isInteger(item))) {
      addReason(context.reasons, "INVALID_SOURCE_SHAPE", `${path}.${key}`, sourceKind);
      continue;
    }
    mergeScalar(context.draft.build as Record<string, unknown>, key, item as number | undefined, sourceKind, context.reasons, `${path}.${key}`);
  }
}

function transformSupport(
  context: TransformContext,
  source: Record<string, unknown>,
  sourceKind: LegacySourceKind,
  rootPath = "$",
): void {
  for (const key of ["supportUrl", "privacyPolicyUrl"] as const) {
    if (source[key] === undefined) continue;
    readOptionalString(source[key], sourceKind, context.reasons, `${rootPath}.${key}`);
    if (typeof source[key] === "string") {
      addReason(context.reasons, "FREE_TEXT_REQUIRES_INPUT", `${rootPath}.${key}`, sourceKind);
    }
  }
}

function transformGooglePlay(source: Record<string, unknown>, context: TransformContext): void {
  const kind = "GOOGLE_PLAY_CONFIG" as const;
  const allowed = new Set([
    "defaultLanguage",
    "privacyPolicyUrl", "supportUrl", "enabled", "storeListing", "build",
  ]);
  assertAllowedKeys(source, allowed, kind, context.reasons, "$");
  const locales = new Set<string>();
  const defaultLanguage = readOptionalString(source.defaultLanguage, kind, context.reasons, "$.defaultLanguage");
  if (defaultLanguage) locales.add(defaultLanguage);
  const enabled = readOptionalBoolean(source.enabled, kind, context.reasons, "$.enabled") ?? true;
  if (source.storeListing !== undefined) {
    const listingAllowed = new Set(["appName", "shortDescription", "fullDescription"]);
    if (assertAllowedKeys(source.storeListing, listingAllowed, kind, context.reasons, "$.storeListing")) {
      for (const [key, field] of [
        ["appName", "displayName"],
        ["shortDescription", "subtitle"],
        ["fullDescription", "description"],
      ] as const) {
        for (const [locale, text] of readLocalizedStrings(
          source.storeListing[key], kind, context.reasons, `$.storeListing.${key}`,
        )) {
          locales.add(locale);
          mergeLocalization(context, locale, field, text, kind);
        }
      }
    }
  }
  transformBuild(context, source.build, kind, "$.build");
  transformSupport(context, source, kind);
  mergeMarket(context, "google-play", enabled, locales, kind);
}

function transformAppStore(source: Record<string, unknown>, context: TransformContext): void {
  const kind = "APP_STORE_CONFIG" as const;
  const allowed = new Set([
    "primaryLanguage",
    "privacyPolicyUrl", "supportUrl", "enabled", "storeListing", "build",
  ]);
  assertAllowedKeys(source, allowed, kind, context.reasons, "$");
  const locales = new Set<string>();
  const primaryLanguage = readOptionalString(source.primaryLanguage, kind, context.reasons, "$.primaryLanguage");
  if (primaryLanguage) locales.add(primaryLanguage);
  const enabled = readOptionalBoolean(source.enabled, kind, context.reasons, "$.enabled") ?? true;
  if (source.storeListing !== undefined) {
    const listingAllowed = new Set(["appName", "subtitle", "description", "keywords"]);
    if (assertAllowedKeys(source.storeListing, listingAllowed, kind, context.reasons, "$.storeListing")) {
      for (const [key, field] of [
        ["appName", "displayName"],
        ["subtitle", "subtitle"],
        ["description", "description"],
      ] as const) {
        for (const [locale, text] of readLocalizedStrings(
          source.storeListing[key], kind, context.reasons, `$.storeListing.${key}`, primaryLanguage,
        )) {
          locales.add(locale);
          mergeLocalization(context, locale, field, text, kind);
        }
      }
      for (const [locale, keywords] of readLocalizedStrings(
        source.storeListing.keywords, kind, context.reasons, "$.storeListing.keywords", primaryLanguage,
      )) {
        locales.add(locale);
        mergeLocalization(
          context,
          locale,
          "keywords",
          [...new Set(keywords.split(",").map((item) => item.trim()).filter(Boolean))].sort(compareText),
          kind,
        );
      }
    }
  }
  transformBuild(context, source.build, kind, "$.build", true);
  transformSupport(context, source, kind);
  mergeMarket(context, "app-store", enabled, locales, kind);
}

function transformAppsInToss(source: Record<string, unknown>, context: TransformContext): void {
  const kind = "APPS_IN_TOSS_CONFIG" as const;
  const allowed = new Set(["locale", "enabled", "app", "privacyPolicyUrl", "supportUrl", "build"]);
  assertAllowedKeys(source, allowed, kind, context.reasons, "$");
  const locales = new Set<string>();
  const locale = readOptionalString(source.locale, kind, context.reasons, "$.locale");
  if (locale) locales.add(locale);
  const enabled = readOptionalBoolean(source.enabled, kind, context.reasons, "$.enabled") ?? true;
  if (source.app !== undefined) {
    const appAllowed = new Set(["displayName", "displayNameEnglish"]);
    if (assertAllowedKeys(source.app, appAllowed, kind, context.reasons, "$.app")) {
      const displayName = readOptionalString(source.app.displayName, kind, context.reasons, "$.app.displayName");
      if (displayName && !locale) addReason(context.reasons, "LOCALIZATION_LOCALE_MISSING", "$.app.displayName", kind);
      if (displayName && locale) mergeLocalization(context, locale, "displayName", displayName, kind);
      const englishName = readOptionalString(
        source.app.displayNameEnglish, kind, context.reasons, "$.app.displayNameEnglish",
      );
      if (englishName) {
        locales.add("en-US");
        mergeLocalization(context, "en-US", "displayName", englishName, kind);
      }
    }
  }
  transformBuild(context, source.build, kind, "$.build");
  transformSupport(context, source, kind);
  mergeMarket(context, "apps-in-toss", enabled, locales, kind);
}

function transformPlatformRegistry(source: Record<string, unknown>, context: TransformContext): void {
  const kind = "PLATFORM_APP_REGISTRY" as const;
  const allowed = new Set(["platformVersion", "platform_version"]);
  assertAllowedKeys(source, allowed, kind, context.reasons, "$");
  const camel = readOptionalString(source.platformVersion, kind, context.reasons, "$.platformVersion");
  const snake = readOptionalString(source.platform_version, kind, context.reasons, "$.platform_version");
  if (camel && snake && camel !== snake) {
    addReason(context.reasons, "CONFLICTING_DESIRED_STATE", "$.platformVersion", kind);
    return;
  }
  if (camel ?? snake) {
    addReason(context.reasons, "FREE_TEXT_REQUIRES_INPUT", "$.platformVersion", kind);
  }
}

function mergeDirectPayload(
  source: Record<string, unknown>,
  sourceKind: "SEORILABS_APP_YAML" | "SEORILABS_BACKOFFICE_JSON",
  context: TransformContext,
): void {
  if (sourceKind === "SEORILABS_BACKOFFICE_JSON" && isLegacyBackofficeToolManifest(source)) {
    // v1 Backoffice 도구 manifest는 앱 desired state가 아니다. 원문을 중앙
    // ConfigRevision으로 복사하지 않고 AutomationDefinition/비운영 값 사람 검토로 보낸다.
    addReason(context.reasons, "UNSUPPORTED_FIELD", "$", sourceKind);
    return;
  }
  const parsed = configRevisionPayloadSchema.safeParse(source);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      addReason(context.reasons, "INVALID_DESIRED_STATE", issuePath(issue.path), sourceKind);
    }
    return;
  }
  for (const market of parsed.data.markets) {
    mergeMarket(context, market.market, market.enabled, market.locales, sourceKind);
  }
  for (const localization of parsed.data.localizations ?? []) {
    for (const field of ["displayName", "subtitle", "description", "keywords"] as const) {
      const value = localization[field];
      if (value !== undefined) mergeLocalization(context, localization.locale, field, value, sourceKind);
    }
  }
  if ((parsed.data.assets?.length ?? 0) > 0) {
    // v1 중앙 asset 계약에는 market dimension이 없어 legacy multi-market
    // identity를 손실 없이 옮길 수 없다. 원문을 추측해 합치지 않는다.
    addReason(context.reasons, "UNSUPPORTED_FIELD", "$.assets", sourceKind);
  }
  for (const [key, value] of Object.entries(parsed.data.build ?? {})) {
    if (typeof value === "string") {
      addReason(context.reasons, "FREE_TEXT_REQUIRES_INPUT", `$.build.${key}`, sourceKind);
    } else if (typeof value === "number") {
      mergeScalar(
        context.draft.build as Record<string, unknown>, key, value, sourceKind, context.reasons, `$.build.${key}`,
      );
    } else {
      addReason(context.reasons, "UNSUPPORTED_FIELD", `$.build.${key}`, sourceKind);
    }
  }
  for (const [key, value] of Object.entries(parsed.data.support ?? {})) {
    void value;
    addReason(context.reasons, "FREE_TEXT_REQUIRES_INPUT", `$.support.${key}`, sourceKind);
  }
}

function isLegacyBackofficeToolManifest(source: Record<string, unknown>): boolean {
  const allowed = new Set(["$schema", "version", "summary", "tools", "analytics"]);
  return Object.keys(source).every((key) => allowed.has(key))
    && source.$schema === LEGACY_BACKOFFICE_TOOL_MANIFEST_SCHEMA
    && source.version === 1
    && typeof source.summary === "string"
    && source.summary.trim().length > 0
    && Array.isArray(source.tools)
    && source.tools.length > 0
    && source.tools.every((tool) => (
      isRecord(tool)
      && typeof tool.id === "string"
      && tool.id.trim().length > 0
    ))
    && (source.analytics === undefined || isRecord(source.analytics));
}

function canonicalPayload(draft: MutablePayload): DraftableConfigRevisionPayload {
  const markets = [...draft.markets.values()]
    .map((market) => ({ ...market, locales: [...market.locales].sort(compareText) }))
    .sort((left, right) => (MARKET_ORDER.get(left.market) ?? 99) - (MARKET_ORDER.get(right.market) ?? 99));
  const localizations = [...draft.localizations.values()]
    .map((localization) => ({
      ...localization,
      ...(localization.keywords ? { keywords: [...localization.keywords].sort(compareText) } : {}),
    }))
    .sort((left, right) => compareText(left.locale, right.locale));
  const uniqueAssets = new Map<string, NonNullable<DraftableConfigRevisionPayload["assets"]>[number]>();
  for (const asset of draft.assets) {
    uniqueAssets.set(canonicalJson(asset as JsonValue), asset);
  }
  const assets = [...uniqueAssets.values()].sort((left, right) => compareText(
    `${left.kind}\u0000${left.locale ?? ""}\u0000${left.objectKey}\u0000${left.checksum}`,
    `${right.kind}\u0000${right.locale ?? ""}\u0000${right.objectKey}\u0000${right.checksum}`,
  ));
  return {
    schemaVersion: 1,
    markets,
    ...(localizations.length > 0 ? { localizations } : {}),
    ...(assets.length > 0 ? { assets } : {}),
    ...(Object.keys(draft.build).length > 0 ? { build: draft.build } : {}),
    ...(Object.keys(draft.support).length > 0 ? { support: draft.support } : {}),
  };
}

function sortedReasons(reasons: LegacyTransformReason[]): LegacyTransformReason[] {
  const unique = new Map<string, LegacyTransformReason>();
  for (const reason of reasons) {
    const key = `${reason.code}\u0000${reason.sourceKind ?? ""}\u0000${reason.path}`;
    unique.set(key, reason);
  }
  return [...unique.entries()].sort(([left], [right]) => compareText(left, right)).map(([, reason]) => reason);
}

function sourceInputDigest(sources: readonly LegacySourceInput[]): string {
  const entries = sources.map((source) => ({
    sourceKind: source.sourceKind,
    repository: source.repository,
    sourceSha: source.sourceSha.toLowerCase(),
    path: normalizeLegacySourcePath(source.path) ?? source.path,
    status: source.status,
    textDigest: typeof source.text === "string" ? sha256(source.text) : null,
  })).sort((left, right) => compareText(
    `${left.sourceKind}\u0000${left.repository}\u0000${left.path}\u0000${left.sourceSha}\u0000${left.status}\u0000${left.textDigest}`,
    `${right.sourceKind}\u0000${right.repository}\u0000${right.path}\u0000${right.sourceSha}\u0000${right.status}\u0000${right.textDigest}`,
  ));
  return sha256(canonicalJson(entries as JsonValue));
}

export function transformLegacySources(sources: readonly LegacySourceInput[]): LegacyTransformResult {
  const reasons: LegacyTransformReason[] = [];
  const byKind = new Map<LegacySourceKind, LegacySourceInput[]>();
  const allowedKinds = new Set<string>(LEGACY_SOURCE_DEFINITIONS.map((definition) => definition.sourceKind));
  for (const source of sources) {
    if (!allowedKinds.has(source.sourceKind)) {
      addReason(reasons, "SOURCE_KIND_NOT_ALLOWED", "$");
      continue;
    }
    const entries = byKind.get(source.sourceKind) ?? [];
    entries.push(source);
    byKind.set(source.sourceKind, entries);
  }
  for (const definition of LEGACY_SOURCE_DEFINITIONS) {
    const entries = byKind.get(definition.sourceKind) ?? [];
    if (entries.length === 0) addReason(reasons, "PARTIAL_CROSS_REPO_VECTOR", "$", definition.sourceKind);
    if (entries.length > 1) addReason(reasons, "DUPLICATE_SOURCE", "$", definition.sourceKind);
  }

  const uniqueSources = LEGACY_SOURCE_DEFINITIONS.flatMap((definition) => {
    const entries = byKind.get(definition.sourceKind) ?? [];
    return entries.length === 1 ? entries : [];
  });
  for (const source of uniqueSources) {
    if (!matchesLegacySourcePath(source.sourceKind, source.path)) {
      addReason(reasons, "SOURCE_PATH_MISMATCH", "$", source.sourceKind);
    }
    if (!REPOSITORY_PATTERN.test(source.repository) || !SHA_PATTERN.test(source.sourceSha)) {
      addReason(reasons, "SOURCE_PROVENANCE_INVALID", "$", source.sourceKind);
    }
    if (!["PRESENT", "ABSENT", "UNREADABLE"].includes(source.status)) {
      addReason(reasons, "SOURCE_STATUS_INVALID", "$", source.sourceKind);
    }
    if (source.status === "PRESENT" && typeof source.text !== "string") {
      addReason(reasons, "SOURCE_CONTENT_MISSING", "$", source.sourceKind);
    }
    if (source.status !== "PRESENT" && source.text !== undefined) {
      addReason(reasons, "SOURCE_CONTENT_UNEXPECTED", "$", source.sourceKind);
    }
    if (source.status === "UNREADABLE") addReason(reasons, "SOURCE_UNREADABLE", "$", source.sourceKind);
  }

  const appSources = uniqueSources.filter((source) => legacySourceDefinition(source.sourceKind).repositoryScope === "APP");
  const platformSources = uniqueSources.filter(
    (source) => legacySourceDefinition(source.sourceKind).repositoryScope === "PLATFORM",
  );
  const appRefs = new Set(appSources.map((source) => `${source.repository}@${source.sourceSha.toLowerCase()}`));
  const platformRefs = new Set(platformSources.map((source) => `${source.repository}@${source.sourceSha.toLowerCase()}`));
  if (
    appSources.length !== LEGACY_SOURCE_DEFINITIONS.filter((item) => item.repositoryScope === "APP").length
    || platformSources.length !== 1
    || appRefs.size !== 1
    || platformRefs.size !== 1
    || (appSources[0] && platformSources[0] && appSources[0].repository === platformSources[0].repository)
  ) {
    addReason(reasons, "PARTIAL_CROSS_REPO_VECTOR", "$");
  }

  const context: TransformContext = {
    draft: { markets: new Map(), localizations: new Map(), assets: [], build: {}, support: {} },
    reasons,
    transformableKinds: new Set(),
  };
  for (const source of uniqueSources) {
    if (source.status !== "PRESENT") continue;
    const reasonCount = reasons.length;
    const parsed = parseSource(source, reasons);
    if (!parsed) continue;
    switch (source.sourceKind) {
      case "GOOGLE_PLAY_CONFIG": transformGooglePlay(parsed, context); break;
      case "APP_STORE_CONFIG": transformAppStore(parsed, context); break;
      case "APPS_IN_TOSS_CONFIG": transformAppsInToss(parsed, context); break;
      case "MARKET_LAUNCH_STATE":
        addReason(reasons, "PROVIDER_STATE_AMBIGUITY", "$", source.sourceKind);
        break;
      case "PLATFORM_APP_REGISTRY": transformPlatformRegistry(parsed, context); break;
      case "SEORILABS_APP_YAML": mergeDirectPayload(parsed, source.sourceKind, context); break;
      case "SEORILABS_BACKOFFICE_JSON": mergeDirectPayload(parsed, source.sourceKind, context); break;
    }
    if (!reasons.slice(reasonCount).some(isBlockingReason)) {
      context.transformableKinds.add(source.sourceKind);
    }
  }

  const present = uniqueSources.filter((source) => source.status === "PRESENT").length;
  if (present === 0) addReason(reasons, "NO_REPRESENTABLE_SOURCE", "$");
  const payload = canonicalPayload(context.draft);
  const validated = configRevisionPayloadSchema.safeParse(payload);
  if (!validated.success) {
    for (const issue of validated.error.issues) {
      addReason(reasons, "INVALID_DESIRED_STATE", issuePath(issue.path));
    }
  }
  const finalReasons = sortedReasons(reasons);
  const presentKinds = new Set(
    uniqueSources.filter((source) => source.status === "PRESENT").map((source) => source.sourceKind),
  );
  const blockedKinds = new Set(
    finalReasons
      .map((reason) => reason.sourceKind)
      .filter((sourceKind): sourceKind is LegacySourceKind => sourceKind !== undefined && presentKinds.has(sourceKind)),
  );
  const vectorComplete = uniqueSources.length === LEGACY_SOURCE_DEFINITIONS.length
    && uniqueSources.every((source) => source.status !== "UNREADABLE")
    && !finalReasons.some((reason) => [
      "PARTIAL_CROSS_REPO_VECTOR",
      "DUPLICATE_SOURCE",
      "SOURCE_PATH_MISMATCH",
      "SOURCE_PROVENANCE_INVALID",
      "SOURCE_STATUS_INVALID",
      "SOURCE_UNREADABLE",
      "SOURCE_CONTENT_MISSING",
      "SOURCE_CONTENT_UNEXPECTED",
    ].includes(reason.code));
  const coverage: LegacyTransformCoverage = {
    status: vectorComplete ? "COMPLETE" : "PARTIAL",
    expected: LEGACY_SOURCE_DEFINITIONS.length,
    reported: uniqueSources.length,
    present,
    absent: uniqueSources.filter((source) => source.status === "ABSENT").length,
    readable: uniqueSources.filter((source) => source.status === "PRESENT" && typeof source.text === "string").length,
    transformable: context.transformableKinds.size,
    blocked: blockedKinds.size,
  };
  const inputDigest = sourceInputDigest(sources);
  if (finalReasons.some(isBlockingReason) || !validated.success) {
    return {
      status: "NEEDS_INPUT",
      transformVersion: LEGACY_TRANSFORM_VERSION,
      inputDigest,
      payloadDigest: null,
      coverage,
      reasons: finalReasons,
    };
  }
  const normalized = canonicalPayload({
    ...context.draft,
    markets: new Map(validated.data.markets.map((market) => [market.market, market])),
    localizations: new Map((validated.data.localizations ?? []).map((item) => [item.locale, item])),
    assets: validated.data.assets ?? [],
    build: validated.data.build ?? {},
    support: validated.data.support ?? {},
  });
  const draftResult = {
    transformVersion: LEGACY_TRANSFORM_VERSION,
    inputDigest,
    payload: normalized,
    payloadDigest: sha256(canonicalJson(normalized as JsonValue)),
    coverage,
  };
  if (finalReasons.length > 0) {
    return { ...draftResult, status: "DRAFTABLE_WITH_INPUT", reasons: finalReasons };
  }
  return { ...draftResult, status: "DRAFTABLE", reasons: [] };
}

function valueType(value: JsonValue): "null" | "array" | "object" | "scalar" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "scalar";
}

function collectDiffs(left: JsonValue, right: JsonValue, path: string, diffs: LegacyParityDiff[]): void {
  const leftType = valueType(left);
  const rightType = valueType(right);
  if (leftType !== rightType) {
    diffs.push({ path, code: "TYPE_MISMATCH" });
    return;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) diffs.push({ path, code: "ARRAY_LENGTH_MISMATCH" });
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      collectDiffs(left[index], right[index], `${path}[${index}]`, diffs);
    }
    return;
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(compareText);
    for (const key of keys) {
      const nestedPath = childPath(path, key);
      if (!(key in left)) diffs.push({ path: nestedPath, code: "MISSING_IN_LEGACY" });
      else if (!(key in right)) diffs.push({ path: nestedPath, code: "MISSING_IN_CENTRAL" });
      else collectDiffs(left[key] as JsonValue, right[key] as JsonValue, nestedPath, diffs);
    }
    return;
  }
  if (left !== right) diffs.push({ path, code: "VALUE_MISMATCH" });
}

/**
 * 사람이 중앙 원장으로 분리했다고 승인한 값은 legacy payload에 남지 않는다.
 * 따라서 reviewable transform은 legacy가 실제로 구조화한 값만 중앙 상태에 그대로
 * 존재하는지 확인한다. 중앙에만 있는 locale, asset, support 값은 승인된 중앙 원장
 * 소유이므로 비교 대상에서 제외하지만 legacy 쪽 값을 바꾸거나 빼는 것은 허용하지 않는다.
 */
function collectResolvedSubsetDiffs(
  left: JsonValue,
  right: JsonValue,
  path: string,
  diffs: LegacyParityDiff[],
): void {
  const leftType = valueType(left);
  const rightType = valueType(right);
  if (leftType !== rightType) {
    diffs.push({ path, code: "TYPE_MISMATCH" });
    return;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length > right.length) {
      diffs.push({ path, code: "ARRAY_LENGTH_MISMATCH" });
      return;
    }
    const used = new Set<number>();
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      let matched = false;
      for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
        if (used.has(rightIndex)) continue;
        const candidateDiffs: LegacyParityDiff[] = [];
        collectResolvedSubsetDiffs(left[leftIndex], right[rightIndex], `${path}[${leftIndex}]`, candidateDiffs);
        if (candidateDiffs.length === 0) {
          used.add(rightIndex);
          matched = true;
          break;
        }
      }
      if (!matched) diffs.push({ path: `${path}[${leftIndex}]`, code: "VALUE_MISMATCH" });
    }
    return;
  }
  if (isRecord(left) && isRecord(right)) {
    for (const key of Object.keys(left).sort(compareText)) {
      const nestedPath = childPath(path, key);
      if (!(key in right)) diffs.push({ path: nestedPath, code: "MISSING_IN_CENTRAL" });
      else collectResolvedSubsetDiffs(left[key] as JsonValue, right[key] as JsonValue, nestedPath, diffs);
    }
    return;
  }
  if (left !== right) diffs.push({ path, code: "VALUE_MISMATCH" });
}

export function compareResolvedLegacySubset(
  legacy: LegacyTransformResult,
  centralPayload: unknown,
): LegacyShadowParity {
  const central = configRevisionPayloadSchema.safeParse(centralPayload);
  const canonicalCentral = central.success
    ? canonicalPayload({
      markets: new Map(central.data.markets.map((market) => [market.market, market])),
      localizations: new Map((central.data.localizations ?? []).map((item) => [item.locale, item])),
      assets: central.data.assets ?? [],
      build: central.data.build ?? {},
      support: central.data.support ?? {},
    })
    : null;
  const centralDigest = canonicalCentral
    ? sha256(canonicalJson(canonicalCentral as JsonValue))
    : null;
  if (legacy.status !== "DRAFTABLE_WITH_INPUT" || legacy.coverage.status !== "COMPLETE") {
    return {
      status: "NEEDS_INPUT",
      transformVersion: legacy.transformVersion,
      inputDigest: legacy.inputDigest,
      coverage: legacy.coverage,
      legacyDigest: legacy.status === "NEEDS_INPUT" ? null : legacy.payloadDigest,
      centralDigest,
      diffs: [{
        path: "$",
        code: legacy.coverage.status === "PARTIAL" ? "PARTIAL_COVERAGE" : "TRANSFORM_NEEDS_INPUT",
      }],
    };
  }
  if (!canonicalCentral) {
    return {
      status: "NEEDS_INPUT",
      transformVersion: legacy.transformVersion,
      inputDigest: legacy.inputDigest,
      coverage: legacy.coverage,
      legacyDigest: legacy.payloadDigest,
      centralDigest: null,
      diffs: [{ path: "$", code: "TARGET_INVALID" }],
    };
  }
  const diffs: LegacyParityDiff[] = [];
  collectResolvedSubsetDiffs(legacy.payload as JsonValue, canonicalCentral as JsonValue, "$", diffs);
  return {
    status: diffs.length === 0 ? "MATCH" : "MISMATCH",
    transformVersion: legacy.transformVersion,
    inputDigest: legacy.inputDigest,
    coverage: legacy.coverage,
    legacyDigest: legacy.payloadDigest,
    centralDigest,
    diffs,
  };
}

export function compareLegacyShadow(
  legacy: LegacyTransformResult,
  centralPayload: unknown,
): LegacyShadowParity {
  const central = configRevisionPayloadSchema.safeParse(centralPayload);
  const canonicalCentral = central.success
    ? canonicalPayload({
      markets: new Map(central.data.markets.map((market) => [market.market, market])),
      localizations: new Map((central.data.localizations ?? []).map((item) => [item.locale, item])),
      assets: central.data.assets ?? [],
      build: central.data.build ?? {},
      support: central.data.support ?? {},
    })
    : null;
  const centralDigest = canonicalCentral
    ? sha256(canonicalJson(canonicalCentral as JsonValue))
    : null;
  if (legacy.status !== "DRAFTABLE" || legacy.coverage.status !== "COMPLETE") {
    return {
      status: "NEEDS_INPUT",
      transformVersion: legacy.transformVersion,
      inputDigest: legacy.inputDigest,
      coverage: legacy.coverage,
      legacyDigest: legacy.payloadDigest,
      centralDigest,
      diffs: [{
        path: "$",
        code: legacy.coverage.status === "PARTIAL" ? "PARTIAL_COVERAGE" : "TRANSFORM_NEEDS_INPUT",
      }],
    };
  }
  if (!canonicalCentral) {
    return {
      status: "NEEDS_INPUT",
      transformVersion: legacy.transformVersion,
      inputDigest: legacy.inputDigest,
      coverage: legacy.coverage,
      legacyDigest: legacy.payloadDigest,
      centralDigest: null,
      diffs: [{ path: "$", code: "TARGET_INVALID" }],
    };
  }
  const diffs: LegacyParityDiff[] = [];
  collectDiffs(legacy.payload as JsonValue, canonicalCentral as JsonValue, "$", diffs);
  return {
    status: diffs.length === 0 ? "MATCH" : "MISMATCH",
    transformVersion: legacy.transformVersion,
    inputDigest: legacy.inputDigest,
    coverage: legacy.coverage,
    legacyDigest: legacy.payloadDigest,
    centralDigest,
    diffs,
  };
}
