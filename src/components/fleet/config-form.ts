/**
 * Fleet 중앙 편집기의 구조화 폼 draft와 ConfigRevision payload 사이의 순수 변환이다.
 * 검증은 하지 않는다. 저장·검증은 서버의 `configRevisionPayloadSchema` 한 곳만 수행하며
 * 이 모듈은 폼 입력을 그 계약이 읽는 JSON 모양으로 옮기기만 한다.
 */

export interface MarketDraft {
  market: string;
  enabled: boolean;
  locales: string;
  releaseChannel: string;
}

export interface LocalizationDraft {
  market: string;
  locale: string;
  displayName: string;
  subtitle: string;
  description: string;
  keywords: string;
}

export interface AssetDraft {
  market: string;
  kind: string;
  locale: string;
  objectKey: string;
  checksum: string;
}

export interface ComplianceDraftRow {
  market: string;
  declaration: string;
  valueKind: "text" | "boolean" | "record";
  text: string;
  boolean: boolean;
  record: string;
  evidenceRef: string;
}

export interface IamDraft {
  role: string;
  logicalPrincipalId: string;
  publicIdentity: string;
}

export interface FirebaseAppDraft {
  platform: string;
  publicAppId: string;
  packageId: string;
  bundleId: string;
  aitAppName: string;
}

export interface AppCheckRegistrationDraft {
  platform: string;
  publicAppId: string;
  status: string;
  provider: string;
}

export interface AppCheckApiDraft {
  api: string;
  state: string;
}

export interface WorkspaceGroupDraft {
  email: string;
  role: string;
}

export interface DelegationDraft {
  publicClientId: string;
  scopes: string;
}

export interface BlueprintDraft {
  declared: boolean;
  organizationId: string;
  folderId: string;
  billingAccountId: string;
  projectId: string;
  projectNumber: string;
  region: string;
  apis: string;
  iam: IamDraft[];
  budgetCurrencyCode: string;
  budgetMonthlyAmount: string;
  budgetAlertThresholds: string;
  authProviders: string;
  appCheckManagementMode: string;
  appCheckRegistrations: AppCheckRegistrationDraft[];
  appCheckApis: AppCheckApiDraft[];
  firestoreRulesChecksum: string;
  firestoreIndexesChecksum: string;
  storageRulesChecksum: string;
  functionsRegion: string;
  functionsRuntime: string;
  functionsEnabled: boolean;
  firebaseApps: FirebaseAppDraft[];
  ga4PropertyId: string;
  bigQueryProjectId: string;
  datasetId: string;
  analyticsLocation: string;
  workspaceGroups: WorkspaceGroupDraft[];
  delegations: DelegationDraft[];
  workspaceEnabled: boolean;
  provisionerGcp: string;
  provisionerFirebase: string;
  provisionerWorkspace: string;
}

export interface ConfigDraft {
  markets: MarketDraft[];
  localizations: LocalizationDraft[];
  assets: AssetDraft[];
  buildWorkflowBundleSha: string;
  buildWorkflowBundleDigest: string;
  buildDependencyAuditException: Record<string, unknown> | null;
  buildPlatformVersion: string;
  buildMinSdk: string;
  buildTargetSdk: string;
  supportUrl: string;
  privacyPolicyUrl: string;
  complianceDrafts: ComplianceDraftRow[];
  blueprint: BlueprintDraft;
}

export const MARKETS = ["google-play", "app-store", "apps-in-toss"] as const;
export const RELEASE_CHANNEL_BY_MARKET: Record<string, string> = {
  "google-play": "internal",
  "app-store": "testflight",
  "apps-in-toss": "private",
};
export const ASSET_KINDS = ["icon", "feature-graphic", "thumbnail", "screenshot"] as const;
export const COMPLIANCE_DECLARATIONS = [
  "data-safety",
  "privacy",
  "content-rating",
  "export-compliance",
  "review-notes",
] as const;
export const APP_CHECK_MANAGEMENT_MODES = ["MONITOR", "ENFORCE"] as const;
export const APP_CHECK_REGISTRATION_STATES = ["REGISTERED", "UNREGISTERED"] as const;
export const APP_CHECK_PROVIDERS = [
  "PLAY_INTEGRITY",
  "APP_ATTEST",
  "DEVICE_CHECK",
  "RECAPTCHA_V3",
  "RECAPTCHA_ENTERPRISE",
  "CUSTOM",
] as const;
export const APP_CHECK_APIS = ["AUTHENTICATION", "FIRESTORE", "STORAGE", "FUNCTIONS"] as const;
export const APP_CHECK_API_STATES = ["OFF", "ENFORCED", "NOT_APPLICABLE"] as const;
export const FIREBASE_PLATFORMS = ["ANDROID", "IOS", "WEB", "AIT"] as const;
export const WORKSPACE_ROLES = ["VIEWER", "OPERATOR", "ADMIN"] as const;
export const BUDGET_CURRENCIES = ["KRW", "USD"] as const;

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "string" ? value : "";
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.map(text).join(", ") : "";
}

function splitList(value: string): string[] {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function trimmed(value: string): string | undefined {
  const next = value.trim();
  return next.length > 0 ? next : undefined;
}

function integer(value: string): number | undefined {
  const next = value.trim();
  if (!next) return undefined;
  const parsed = Number(next);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function recordValue(raw: string): string | number | boolean | null {
  const value = raw.trim();
  if (value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  const numeric = Number(value);
  return value !== "" && Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(value) ? numeric : value;
}

function pairsFromRecord(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, entry]) => `${key}=${entry === null ? "" : text(entry)}`)
    .join("\n");
}

function recordFromPairs(value: string): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const line of value.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    const separator = trimmedLine.indexOf("=");
    if (separator < 0) {
      result[trimmedLine] = null;
      continue;
    }
    result[trimmedLine.slice(0, separator).trim()] = recordValue(trimmedLine.slice(separator + 1));
  }
  return result;
}

export function emptyBlueprintDraft(): BlueprintDraft {
  return {
    declared: false,
    organizationId: "",
    folderId: "",
    billingAccountId: "",
    projectId: "",
    projectNumber: "",
    region: "",
    apis: "",
    iam: [],
    budgetCurrencyCode: "KRW",
    budgetMonthlyAmount: "",
    budgetAlertThresholds: "",
    authProviders: "",
    appCheckManagementMode: "MONITOR",
    appCheckRegistrations: [],
    appCheckApis: [],
    firestoreRulesChecksum: "",
    firestoreIndexesChecksum: "",
    storageRulesChecksum: "",
    functionsRegion: "",
    functionsRuntime: "",
    functionsEnabled: false,
    firebaseApps: [],
    ga4PropertyId: "",
    bigQueryProjectId: "",
    datasetId: "",
    analyticsLocation: "",
    workspaceGroups: [],
    delegations: [],
    workspaceEnabled: false,
    provisionerGcp: "",
    provisionerFirebase: "",
    provisionerWorkspace: "",
  };
}

export function emptyConfigDraft(): ConfigDraft {
  return {
    markets: [],
    localizations: [],
    assets: [],
    buildWorkflowBundleSha: "",
    buildWorkflowBundleDigest: "",
    buildDependencyAuditException: null,
    buildPlatformVersion: "",
    buildMinSdk: "",
    buildTargetSdk: "",
    supportUrl: "",
    privacyPolicyUrl: "",
    complianceDrafts: [],
    blueprint: emptyBlueprintDraft(),
  };
}

export function draftFromPayload(payload: unknown): ConfigDraft {
  const source = record(payload);
  const build = record(source.build);
  const support = record(source.support);
  const blueprintSource = record(source.projectBlueprint);
  const hasBlueprint = Object.keys(blueprintSource).length > 0;
  const project = record(blueprintSource.project);
  const budget = record(blueprintSource.budget);
  const firebase = record(blueprintSource.firebase);
  const functions = record(firebase.functions);
  const analytics = record(blueprintSource.analytics);
  const workspace = record(blueprintSource.workspace);
  const provisioners = record(blueprintSource.provisioners);
  const blueprint = emptyBlueprintDraft();

  return {
    markets: array(source.markets).map((entry) => {
      const item = record(entry);
      return {
        market: text(item.market),
        enabled: item.enabled === true,
        locales: list(item.locales),
        releaseChannel: text(item.releaseChannel),
      };
    }),
    localizations: array(source.localizations).map((entry) => {
      const item = record(entry);
      return {
        market: text(item.market),
        locale: text(item.locale),
        displayName: text(item.displayName),
        subtitle: text(item.subtitle),
        description: text(item.description),
        keywords: list(item.keywords),
      };
    }),
    assets: array(source.assets).map((entry) => {
      const item = record(entry);
      return {
        market: text(item.market),
        kind: text(item.kind),
        locale: text(item.locale),
        objectKey: text(item.objectKey),
        checksum: text(item.checksum),
      };
    }),
    buildWorkflowBundleSha: text(build.workflowBundleSha),
    buildWorkflowBundleDigest: text(build.workflowBundleDigest),
    buildDependencyAuditException: Object.keys(record(build.dependencyAuditException)).length > 0
      ? record(build.dependencyAuditException)
      : null,
    buildPlatformVersion: text(build.platformVersion),
    buildMinSdk: text(build.minSdk),
    buildTargetSdk: text(build.targetSdk),
    supportUrl: text(support.supportUrl),
    privacyPolicyUrl: text(support.privacyPolicyUrl),
    complianceDrafts: array(source.complianceDrafts).map((entry) => {
      const item = record(entry);
      const value = item.draft;
      const valueKind = typeof value === "boolean"
        ? "boolean" as const
        : value && typeof value === "object" && !Array.isArray(value)
          ? "record" as const
          : "text" as const;
      return {
        market: text(item.market),
        declaration: text(item.declaration),
        valueKind,
        text: valueKind === "text" ? text(value) : "",
        boolean: value === true,
        record: valueKind === "record" ? pairsFromRecord(record(value)) : "",
        evidenceRef: text(item.evidenceRef),
      };
    }),
    blueprint: hasBlueprint
      ? {
        ...blueprint,
        declared: true,
        organizationId: text(blueprintSource.organizationId),
        folderId: text(blueprintSource.folderId),
        billingAccountId: text(blueprintSource.billingAccountId),
        projectId: text(project.projectId),
        projectNumber: text(project.projectNumber),
        region: text(project.region),
        apis: list(blueprintSource.apis),
        iam: array(blueprintSource.iam).map((entry) => {
          const item = record(entry);
          return {
            role: text(item.role),
            logicalPrincipalId: text(item.logicalPrincipalId),
            publicIdentity: text(item.publicIdentity),
          };
        }),
        budgetCurrencyCode: text(budget.currencyCode) || "KRW",
        budgetMonthlyAmount: text(budget.monthlyAmount),
        budgetAlertThresholds: list(budget.alertThresholds),
        authProviders: list(firebase.authProviders),
        appCheckManagementMode: text(record(firebase.appCheck).managementMode) || "MONITOR",
        appCheckRegistrations: array(record(firebase.appCheck).registrations).map((entry) => {
          const item = record(entry);
          return {
            platform: text(item.platform),
            publicAppId: text(item.publicAppId),
            status: text(item.status) || "UNREGISTERED",
            provider: text(item.provider),
          };
        }),
        appCheckApis: array(record(firebase.appCheck).apiEnforcement).map((entry) => {
          const item = record(entry);
          return { api: text(item.api), state: text(item.state) || "OFF" };
        }),
        firestoreRulesChecksum: text(firebase.firestoreRulesChecksum),
        firestoreIndexesChecksum: text(firebase.firestoreIndexesChecksum),
        storageRulesChecksum: text(firebase.storageRulesChecksum),
        functionsRegion: text(functions.region),
        functionsRuntime: text(functions.runtime),
        functionsEnabled: firebase.functions !== undefined,
        firebaseApps: array(firebase.apps).map((entry) => {
          const item = record(entry);
          return {
            platform: text(item.platform),
            publicAppId: text(item.publicAppId),
            packageId: text(item.packageId),
            bundleId: text(item.bundleId),
            aitAppName: text(item.aitAppName),
          };
        }),
        ga4PropertyId: text(analytics.ga4PropertyId),
        bigQueryProjectId: text(analytics.bigQueryProjectId),
        datasetId: text(analytics.datasetId),
        analyticsLocation: text(analytics.location),
        workspaceGroups: array(workspace.groups).map((entry) => {
          const item = record(entry);
          return { email: text(item.email), role: text(item.role) || "VIEWER" };
        }),
        delegations: array(workspace.domainWideDelegation).map((entry) => {
          const item = record(entry);
          return { publicClientId: text(item.publicClientId), scopes: list(item.scopes) };
        }),
        workspaceEnabled: blueprintSource.workspace !== undefined,
        provisionerGcp: text(provisioners.gcp),
        provisionerFirebase: text(provisioners.firebase),
        provisionerWorkspace: text(provisioners.workspace),
      }
      : blueprint,
  };
}

function blueprintFromDraft(draft: BlueprintDraft): Record<string, unknown> {
  return {
    schemaVersion: 2,
    organizationId: draft.organizationId.trim(),
    ...(trimmed(draft.folderId) ? { folderId: draft.folderId.trim() } : {}),
    billingAccountId: draft.billingAccountId.trim(),
    project: {
      projectId: draft.projectId.trim(),
      ...(trimmed(draft.projectNumber) ? { projectNumber: draft.projectNumber.trim() } : {}),
      region: draft.region.trim(),
    },
    apis: splitList(draft.apis),
    iam: draft.iam.map((entry) => ({
      role: entry.role.trim(),
      logicalPrincipalId: entry.logicalPrincipalId.trim(),
      publicIdentity: entry.publicIdentity.trim(),
    })),
    budget: {
      currencyCode: draft.budgetCurrencyCode,
      monthlyAmount: integer(draft.budgetMonthlyAmount) ?? Number.NaN,
      alertThresholds: splitList(draft.budgetAlertThresholds).map(Number),
    },
    firebase: {
      authProviders: splitList(draft.authProviders),
      appCheck: {
        managementMode: draft.appCheckManagementMode,
        registrations: draft.appCheckRegistrations.map((entry) => ({
          platform: entry.platform,
          publicAppId: entry.publicAppId.trim(),
          status: entry.status,
          ...(trimmed(entry.provider) ? { provider: entry.provider } : {}),
        })),
        apiEnforcement: draft.appCheckApis.map((entry) => ({
          api: entry.api,
          state: entry.state,
        })),
      },
      firestoreRulesChecksum: draft.firestoreRulesChecksum.trim(),
      firestoreIndexesChecksum: draft.firestoreIndexesChecksum.trim(),
      storageRulesChecksum: draft.storageRulesChecksum.trim(),
      ...(draft.functionsEnabled ? { functions: {
        region: draft.functionsRegion.trim(),
        runtime: draft.functionsRuntime.trim(),
      } } : {}),
      apps: draft.firebaseApps.map((entry) => ({
        platform: entry.platform,
        ...(trimmed(entry.publicAppId) ? { publicAppId: entry.publicAppId.trim() } : {}),
        ...(trimmed(entry.packageId) ? { packageId: entry.packageId.trim() } : {}),
        ...(trimmed(entry.bundleId) ? { bundleId: entry.bundleId.trim() } : {}),
        ...(trimmed(entry.aitAppName) ? { aitAppName: entry.aitAppName.trim() } : {}),
      })),
    },
    analytics: {
      ...(trimmed(draft.ga4PropertyId) ? { ga4PropertyId: draft.ga4PropertyId.trim() } : {}),
      bigQueryProjectId: draft.bigQueryProjectId.trim(),
      datasetId: draft.datasetId.trim(),
      location: draft.analyticsLocation.trim(),
    },
    ...(draft.workspaceEnabled ? { workspace: {
      groups: draft.workspaceGroups.map((entry) => ({
        email: entry.email.trim(),
        role: entry.role,
      })),
      domainWideDelegation: draft.delegations.map((entry) => ({
        publicClientId: entry.publicClientId.trim(),
        scopes: splitList(entry.scopes),
      })),
    } } : {}),
    provisioners: {
      gcp: draft.provisionerGcp.trim(),
      firebase: draft.provisionerFirebase.trim(),
      ...(draft.workspaceEnabled ? { workspace: draft.provisionerWorkspace.trim() } : {}),
    },
  };
}

export function payloadFromDraft(draft: ConfigDraft): Record<string, unknown> {
  const build: Record<string, unknown> = {
    ...(trimmed(draft.buildWorkflowBundleSha) ? { workflowBundleSha: draft.buildWorkflowBundleSha.trim() } : {}),
    ...(trimmed(draft.buildWorkflowBundleDigest)
      ? { workflowBundleDigest: draft.buildWorkflowBundleDigest.trim() }
      : {}),
    ...(draft.buildDependencyAuditException
      ? { dependencyAuditException: draft.buildDependencyAuditException }
      : {}),
    ...(trimmed(draft.buildPlatformVersion) ? { platformVersion: draft.buildPlatformVersion.trim() } : {}),
    ...(trimmed(draft.buildMinSdk) ? { minSdk: integer(draft.buildMinSdk) } : {}),
    ...(trimmed(draft.buildTargetSdk) ? { targetSdk: integer(draft.buildTargetSdk) } : {}),
  };
  const support: Record<string, unknown> = {
    ...(trimmed(draft.supportUrl) ? { supportUrl: draft.supportUrl.trim() } : {}),
    ...(trimmed(draft.privacyPolicyUrl) ? { privacyPolicyUrl: draft.privacyPolicyUrl.trim() } : {}),
  };

  return {
    schemaVersion: 1,
    markets: draft.markets.map((entry) => ({
      market: entry.market,
      enabled: entry.enabled,
      locales: splitList(entry.locales),
      ...(trimmed(entry.releaseChannel) ? { releaseChannel: entry.releaseChannel.trim() } : {}),
    })),
    ...(draft.localizations.length > 0
      ? {
        localizations: draft.localizations.map((entry) => ({
          ...(trimmed(entry.market) ? { market: entry.market.trim() } : {}),
          locale: entry.locale.trim(),
          ...(trimmed(entry.displayName) ? { displayName: entry.displayName.trim() } : {}),
          ...(trimmed(entry.subtitle) ? { subtitle: entry.subtitle.trim() } : {}),
          ...(trimmed(entry.description) ? { description: entry.description.trim() } : {}),
          ...(splitList(entry.keywords).length > 0 ? { keywords: splitList(entry.keywords) } : {}),
        })),
      }
      : {}),
    ...(draft.assets.length > 0
      ? {
        assets: draft.assets.map((entry) => ({
          ...(trimmed(entry.market) ? { market: entry.market.trim() } : {}),
          kind: entry.kind,
          ...(trimmed(entry.locale) ? { locale: entry.locale.trim() } : {}),
          objectKey: entry.objectKey.trim(),
          checksum: entry.checksum.trim(),
        })),
      }
      : {}),
    ...(Object.keys(build).length > 0 ? { build } : {}),
    ...(Object.keys(support).length > 0 ? { support } : {}),
    ...(draft.blueprint.declared ? { projectBlueprint: blueprintFromDraft(draft.blueprint) } : {}),
    ...(draft.complianceDrafts.length > 0
      ? {
        complianceDrafts: draft.complianceDrafts.map((entry) => ({
          market: entry.market,
          declaration: entry.declaration,
          state: "DRAFT",
          draft: entry.valueKind === "boolean"
            ? entry.boolean
            : entry.valueKind === "record"
              ? recordFromPairs(entry.record)
              : entry.text,
          ...(trimmed(entry.evidenceRef) ? { evidenceRef: entry.evidenceRef.trim() } : {}),
        })),
      }
      : {}),
  };
}
