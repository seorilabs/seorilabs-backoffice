import { z } from "zod";

const sha40 = z.string().regex(/^[0-9a-f]{40}$/i, "40자리 source SHA가 필요합니다.");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i, "64자리 SHA-256이 필요합니다.");
const jsonRecord = z.record(z.unknown());

export const discoveryObservationSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  sourceSha: sha40,
  sourceRef: z.string().min(1).max(255).optional(),
  observedAt: z.coerce.date(),
  payload: jsonRecord,
  buildTargets: z.array(z.object({
    targetKey: z.string().min(1).max(191),
    stack: z.string().min(1).max(191),
    market: z.string().min(1).max(64).optional(),
    packageId: z.string().min(1).max(255).optional(),
    bundleId: z.string().min(1).max(255).optional(),
    configuration: jsonRecord.optional(),
  })).default([]),
});

export const providerObservationSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  provider: z.string().min(1).max(64),
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(191),
  observedAt: z.coerce.date(),
  payload: jsonRecord,
  externalBinding: z.object({
    bindingType: z.string().min(1).max(64),
    externalId: z.string().min(1).max(191),
    publicIdentity: z.string().max(191).optional(),
    metadata: jsonRecord.optional(),
  }).optional(),
});

export const configRevisionSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  payload: jsonRecord,
});

export const configActivationSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  revision: z.number().int().positive(),
  expectedActiveRevision: z.number().int().nonnegative(),
});

export const agentClaimSchema = z.object({
  workerId: z.string().min(1).max(128),
  leaseSeconds: z.number().int().min(30).max(300).default(300),
});

export const agentLeaseActionSchema = z.object({
  runId: z.string().min(1).max(191),
  generation: z.number().int().positive(),
  leaseToken: z.string().min(32).max(256),
  leaseSeconds: z.number().int().min(30).max(300).default(300),
  result: jsonRecord.optional(),
  error: z.string().max(16_000).optional(),
});

export const sourceShaSchema = sha40;
export const artifactChecksumSchema = sha256;

