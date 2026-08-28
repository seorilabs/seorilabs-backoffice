import { createHash, createHmac } from "node:crypto";

import {
  marketReadbackSchema,
  providerCommandEnvelopeSchema,
  providerReadbackPayloadSchema,
  type MarketReadback,
  type ProviderCommandEnvelope,
  type ProviderReadbackPayload,
} from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { PROVIDER_ADAPTER_IDS } from "@/lib/control-plane/provider-adapters";

export const PROVIDER_EXECUTION_LEASE_TTL_SECONDS = 300;
export const PROVIDER_EXECUTION_APPROVAL_TTL_MS = 30 * 60 * 1_000;

export type ProviderExecutionOperation = "READBACK" | "APPLY" | "UPLOAD_INTERNAL";
export type ProviderExecutionActionClass =
  | "READ_ONLY"
  | "DETERMINISTIC_MUTATION"
  | "PROTECTED_MUTATION"
  | "INTERNAL_UPLOAD"
  | "HUMAN_ONLY";

/** Auth Broker production 정책과 맞춰 mutation은 실행별 승인으로 고정한다. */
export function providerExecutionRequiresApproval(
  actionClass: ProviderExecutionActionClass,
  environment: string,
): boolean {
  if (actionClass === "READ_ONLY") return false;
  if (actionClass === "PROTECTED_MUTATION" || actionClass === "HUMAN_ONLY") return true;
  return environment === "production";
}

export function providerExecutionClaimRequiresApproval(
  actionClass: ProviderExecutionActionClass,
  environment: string,
  resumeMode: "START" | "READBACK_FIRST",
): boolean {
  return resumeMode === "START" && providerExecutionRequiresApproval(actionClass, environment);
}

export interface CredentialExecutionMetadata {
  logicalCredentialId: string;
  credentialGeneration: number;
  policyGeneration: number;
  capability: string;
  publicAccountId: string;
  credentialPublicIdentity: string;
  adapterId: string;
  origin: string;
  environment: string;
  authFactors: unknown;
}

export function providerExecutionCredentialForClaim(
  resumeMode: "START" | "READBACK_FIRST",
  primary: CredentialExecutionMetadata,
  readback: CredentialExecutionMetadata,
): CredentialExecutionMetadata {
  return resumeMode === "READBACK_FIRST" ? readback : primary;
}

export function providerExecutionResumeMode(status: string): "START" | "READBACK_FIRST" {
  return status === "READBACK_REQUIRED" ? "READBACK_FIRST" : "START";
}

export function providerApprovalRequiredSettlementStatus(input: {
  readbackFirst: boolean;
  readbackAttempts: number;
  maxAttempts: number;
}): "WAITING_HUMAN_APPROVAL" | "READBACK_REQUIRED" | "DEAD_LETTER" {
  if (!input.readbackFirst) return "WAITING_HUMAN_APPROVAL";
  return input.readbackAttempts >= input.maxAttempts ? "DEAD_LETTER" : "READBACK_REQUIRED";
}

export function assertDistinctProviderExecutionCredentials(
  primary: CredentialExecutionMetadata,
  readback: CredentialExecutionMetadata,
): void {
  if (
    primary.logicalCredentialId === readback.logicalCredentialId
    || primary.credentialPublicIdentity.toLowerCase()
      === readback.credentialPublicIdentity.toLowerCase()
  ) {
    throw new Error("PROVIDER_READBACK_IDENTITY_NOT_DISTINCT");
  }
}

export interface ProviderExecutionBinding {
  executionId: string;
  generation: number;
  resumeMode: "START" | "READBACK_FIRST";
  operation: ProviderExecutionOperation;
  provider: string;
  repoId: bigint;
  repoFullName: string;
  sourceSha: string;
  configRevision: number;
  desiredHash: string;
  desired: Record<string, unknown>;
  resourceType: string;
  resourceId: string;
  expectedPublicIdentity: string | null;
  artifactChecksum: string | null;
  bindingHash: string;
  credential: CredentialExecutionMetadata;
  approval: {
    id: string;
    mode: "preapproved" | "per_run";
    expiresAt: Date;
  };
}

const BLUEPRINT_ADAPTERS = {
  gcp: {
    provisioner: "gcp" as const,
    capability: "gcp-project-provision",
    readbackCapability: "gcp-inventory-read",
    adapterId: PROVIDER_ADAPTER_IDS.GCP_PROVISIONER,
  },
  bigquery: {
    provisioner: "gcp" as const,
    capability: "gcp-project-provision",
    readbackCapability: "gcp-inventory-read",
    adapterId: PROVIDER_ADAPTER_IDS.GCP_PROVISIONER,
  },
  "google-analytics": {
    provisioner: "gcp" as const,
    capability: "gcp-project-provision",
    readbackCapability: "gcp-inventory-read",
    adapterId: PROVIDER_ADAPTER_IDS.GCP_PROVISIONER,
  },
  firebase: {
    provisioner: "firebase" as const,
    capability: "firebase-provision",
    readbackCapability: "firebase-inventory-read",
    adapterId: PROVIDER_ADAPTER_IDS.FIREBASE_PROVISIONER,
  },
  "google-workspace": {
    provisioner: "workspace" as const,
    capability: "workspace-provision",
    readbackCapability: "workspace-inventory-read",
    adapterId: PROVIDER_ADAPTER_IDS.WORKSPACE_PROVISIONER,
  },
} as const;

const ORIGIN_BY_RESOURCE = {
  "gcp:project": "https://cloudresourcemanager.googleapis.com",
  "gcp:budget": "https://billingbudgets.googleapis.com",
  "gcp:api": "https://serviceusage.googleapis.com",
  "gcp:iam-binding": "https://cloudresourcemanager.googleapis.com",
  "firebase:auth": "https://identitytoolkit.googleapis.com",
  "firebase:app-check": "https://firebaseappcheck.googleapis.com",
  "firebase:firestore-rules": "https://firebaserules.googleapis.com",
  "firebase:firestore-indexes": "https://firestore.googleapis.com",
  "firebase:storage-rules": "https://firebaserules.googleapis.com",
  "firebase:functions": "https://cloudfunctions.googleapis.com",
  "firebase:app-registration": "https://firebase.googleapis.com",
  "bigquery:dataset": "https://bigquery.googleapis.com",
  "google-analytics:ga4-property-link": "https://analyticsadmin.googleapis.com",
  "google-workspace:group": "https://admin.googleapis.com",
  "google-workspace:domain-wide-delegation": "https://admin.googleapis.com",
} as const;

export const MARKET_EXECUTION_CONTRACT = {
  "google-play": {
    accountBindingType: "publisher-account",
    appBindingType: "application",
    adapterId: PROVIDER_ADAPTER_IDS.GOOGLE_PLAY,
    origin: "https://androidpublisher.googleapis.com",
    readbackCapability: "google-play.readback",
    uploadCapability: "google-play.upload.internal",
  },
  "app-store": {
    accountBindingType: "team",
    appBindingType: "application",
    adapterId: PROVIDER_ADAPTER_IDS.APP_STORE_CONNECT,
    origin: "https://api.appstoreconnect.apple.com",
    readbackCapability: "app-store.readback",
    uploadCapability: "app-store.upload.testflight",
  },
  "apps-in-toss": {
    accountBindingType: "workspace",
    appBindingType: "mini-app",
    adapterId: PROVIDER_ADAPTER_IDS.APPS_IN_TOSS,
    origin: "https://apps-in-toss-api.toss.im",
    readbackCapability: "apps-in-toss.readback",
    uploadCapability: "apps-in-toss.upload.private",
  },
} as const;

export type MarketName = keyof typeof MARKET_EXECUTION_CONTRACT;

export function blueprintExecutionContract(provider: string, resourceType: string) {
  const providerContract = BLUEPRINT_ADAPTERS[provider as keyof typeof BLUEPRINT_ADAPTERS];
  const origin = ORIGIN_BY_RESOURCE[`${provider}:${resourceType}` as keyof typeof ORIGIN_BY_RESOURCE];
  if (!providerContract || !origin) return null;
  const protectedMutation = resourceType === "iam-binding" || resourceType === "domain-wide-delegation";
  return {
    ...providerContract,
    origin,
    actionClass: protectedMutation ? "PROTECTED_MUTATION" as const : "DETERMINISTIC_MUTATION" as const,
  };
}

export function providerExecutionBindingHash(input: {
  repoId: bigint;
  repoFullName: string;
  sourceSha: string;
  configRevisionId: string;
  configRevision: number;
  releaseCandidateId?: string | null;
  operation: ProviderExecutionOperation;
  provider: string;
  resourceType: string;
  resourceId: string;
  desiredHash: string;
  desired: Record<string, unknown>;
  expectedPublicIdentity?: string | null;
  publicAccountId: string;
  credentialPublicIdentity: string;
  logicalCredentialId: string;
  credentialGeneration: number;
  policyGeneration: number;
  capability: string;
  adapterId: string;
  origin: string;
  environment: string;
  authFactors: unknown;
  readbackCredential: CredentialExecutionMetadata;
  artifactChecksum?: string | null;
}) {
  return jsonDigest({
    repoId: input.repoId.toString(),
    repoFullName: input.repoFullName,
    sourceSha: input.sourceSha.toLowerCase(),
    configRevisionId: input.configRevisionId,
    configRevision: input.configRevision,
    releaseCandidateId: input.releaseCandidateId ?? null,
    operation: input.operation,
    provider: input.provider,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    desiredHash: input.desiredHash.toLowerCase(),
    desired: input.desired,
    expectedPublicIdentity: input.expectedPublicIdentity ?? null,
    publicAccountId: input.publicAccountId,
    credentialPublicIdentity: input.credentialPublicIdentity,
    logicalCredentialId: input.logicalCredentialId,
    credentialGeneration: input.credentialGeneration,
    policyGeneration: input.policyGeneration,
    capability: input.capability,
    adapterId: input.adapterId,
    origin: input.origin,
    environment: input.environment,
    authFactors: input.authFactors as JsonValue,
    readbackCredential: input.readbackCredential as unknown as JsonValue,
    artifactChecksum: input.artifactChecksum?.toLowerCase() ?? null,
  } as JsonValue);
}

export function providerExecutionLeaseToken(input: {
  signingKey: string | Buffer;
  executionId: string;
  generation: number;
  workerId: string;
}): string {
  if (input.signingKey.length < 32) throw new Error("PROVIDER_EXECUTION_LEASE_SIGNING_KEY_INVALID");
  return createHmac("sha256", input.signingKey)
    .update(`provider-execution-v1\n${input.executionId}\n${input.generation}\n${input.workerId}`)
    .digest("base64url");
}

export function providerExecutionLeaseTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function authFactors(value: unknown): ProviderCommandEnvelope["credential"]["authFactors"] {
  const parsed = providerCommandEnvelopeSchema.shape.credential.shape.authFactors.safeParse(value);
  if (!parsed.success) throw new Error("CREDENTIAL_AUTH_FACTORS_INVALID");
  return parsed.data;
}

/** worker가 arbitrary executable/argv/env를 만들지 못하는 유일한 command envelope compiler다. */
export function compileProviderCommandEnvelope(input: ProviderExecutionBinding): ProviderCommandEnvelope {
  const operation = input.resumeMode === "READBACK_FIRST" ? "READBACK" : input.operation;
  return providerCommandEnvelopeSchema.parse({
    schemaVersion: 1,
    executionId: input.executionId,
    generation: input.generation,
    resumeMode: input.resumeMode,
    adapterId: input.credential.adapterId,
    operation,
    provider: input.provider,
    repoId: input.repoId.toString(),
    origin: input.credential.origin,
    repository: input.repoFullName,
    sourceSha: input.sourceSha.toLowerCase(),
    configRevision: input.configRevision,
    desiredHash: input.desiredHash.toLowerCase(),
    desired: input.desired,
    resource: {
      type: input.resourceType,
      id: input.resourceId,
      environment: input.credential.environment,
      expectedPublicIdentity: input.expectedPublicIdentity,
    },
    artifactChecksum: input.artifactChecksum?.toLowerCase() ?? null,
    credential: {
      logicalId: input.credential.logicalCredentialId,
      generation: input.credential.credentialGeneration,
      policyGeneration: input.credential.policyGeneration,
      capability: input.credential.capability,
      publicAccountId: input.credential.publicAccountId,
      publicIdentity: input.credential.credentialPublicIdentity,
      authFactors: authFactors(input.credential.authFactors),
    },
    approval: {
      id: input.approval.id,
      mode: input.approval.mode,
      expiresAt: input.approval.expiresAt.toISOString(),
      maxUses: 1,
    },
    bindingHash: input.bindingHash,
  });
}

export type BlueprintReadbackDecision =
  | "COMPLIANT"
  | "ABSENT"
  | "DRIFT"
  | "FORBIDDEN"
  | "ERROR";

export function decideBlueprintReadback(
  payload: ProviderReadbackPayload,
  expected: { desiredHash: string; publicIdentity: string | null },
): BlueprintReadbackDecision {
  const readback = providerReadbackPayloadSchema.parse(payload);
  if (readback.visibility === "FORBIDDEN") return "FORBIDDEN";
  if (readback.visibility === "ERROR") return "ERROR";
  if (readback.state === "ABSENT") return "ABSENT";
  if (readback.state !== "PRESENT") return "ERROR";
  if (expected.publicIdentity && readback.publicIdentity !== expected.publicIdentity) return "DRIFT";
  return readback.attributes.desiredHash === expected.desiredHash ? "COMPLIANT" : "DRIFT";
}

export function marketUploadReadbackSucceeded(payload: MarketReadback): boolean {
  const readback = marketReadbackSchema.parse(payload);
  return !["FAILED", "REJECTED", "HUMAN_REQUIRED"].includes(readback.state)
    && ["UPLOAD", "PROCESSING", "DEVICE_QA", "REVIEW", "APPROVAL", "DEPLOYMENT", "PUBLIC"].includes(readback.gate);
}
