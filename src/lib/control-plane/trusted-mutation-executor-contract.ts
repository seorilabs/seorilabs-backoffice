import { z } from "zod";

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/u;
const SHA40 = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SESSION_ID = /^agent-session:[0-9a-f-]{36}$/u;
const requiredUnknown = z.unknown().refine((value) => value !== undefined);

/**
 * 신뢰 실행기 ↔ 중앙 사이의 조작 계약이다. task 계약은 실행기마다 다르지만 claim,
 * heartbeat, step ledger, settlement의 wire 형태는 같아서 여기서만 선언한다.
 */
export const trustedMutationExecutorOperationSchemas = [
  z.object({ operation: z.literal("CLAIM") }).strict(),
  z.object({
    operation: z.literal("HEARTBEAT"),
    sessionId: z.string().regex(SESSION_ID),
    generation: z.number().int().positive(),
  }).strict(),
  z.object({
    operation: z.literal("AUTHORIZE"),
    sessionId: z.string().regex(SESSION_ID),
    mutationIntentDigest: z.string().regex(DIGEST),
    observation: requiredUnknown,
  }).strict(),
  z.object({
    operation: z.literal("STEP_CLAIM"),
    sessionId: z.string().regex(SESSION_ID),
    executionId: z.string().regex(PUBLIC_ID),
    stepKind: z.enum(["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"]),
  }).strict(),
  z.object({
    operation: z.literal("STEP_PLAN"),
    sessionId: z.string().regex(SESSION_ID),
    executionId: z.string().regex(PUBLIC_ID),
    stepId: z.string().regex(PUBLIC_ID),
    attemptId: z.string().regex(PUBLIC_ID),
    generation: z.number().int().positive(),
    expectedTreeSha: z.string().regex(SHA40),
    expectedCommitSha: z.string().regex(SHA40),
  }).strict(),
  z.object({
    operation: z.literal("STEP_COMPLETE"),
    sessionId: z.string().regex(SESSION_ID),
    executionId: z.string().regex(PUBLIC_ID),
    stepId: z.string().regex(PUBLIC_ID),
    attemptId: z.string().regex(PUBLIC_ID),
    generation: z.number().int().positive(),
    stepKind: z.enum(["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"]),
    observation: requiredUnknown,
  }).strict(),
  z.object({
    operation: z.literal("READBACK"),
    sessionId: z.string().regex(SESSION_ID),
    executionId: z.string().regex(PUBLIC_ID),
    observation: requiredUnknown,
  }).strict(),
  z.object({
    operation: z.literal("RECOVERY"),
    sessionId: z.string().regex(SESSION_ID),
  }).strict(),
  z.object({
    operation: z.literal("SETTLE"),
    sessionId: z.string().regex(SESSION_ID),
    mode: z.enum(["START", "READBACK_FIRST"]),
    status: z.enum(["VERIFIED", "NOT_APPLIED", "PARTIAL_VERIFIED", "RESULT_UNKNOWN", "FAILED"]),
    executionId: z.string().regex(PUBLIC_ID).nullable(),
    pullRequestNumber: z.number().int().positive().nullable(),
    pullRequestUrl: z.string().url().startsWith("https://github.com/").nullable(),
    commitSha: z.string().regex(SHA40).nullable(),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{7,190}$/u).nullable(),
  }).strict(),
] as const;

/** caller 본문을 중앙이 만들 수 없는 실행기만 쓰는 승인 번들 검증 조작이다. */
export const trustedBundleVerifyOperationSchema = z.object({
  operation: z.literal("BUNDLE_VERIFY"),
  sessionId: z.string().regex(SESSION_ID),
  candidateDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  payloadDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  approvalPayloadDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  contractDigestsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  runtimeAssetDigestsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).strict();

export const trustedMutationExecutorRequestSchema = z.discriminatedUnion("operation", [
  ...trustedMutationExecutorOperationSchemas,
]);

export type TrustedMutationExecutorRequest = z.infer<typeof trustedMutationExecutorRequestSchema>;
