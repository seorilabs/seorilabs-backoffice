import { createHash } from "node:crypto";
import { z } from "zod";
const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const text = z.string().trim().min(1).max(12000);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (s) =>
      !s.startsWith("/") &&
      !s.split("/").some((p) => p === ".." || p === ".git") &&
      !s.includes("\\") &&
      !s.includes("\0"),
    "relative path required",
  );
const reference = z
  .string()
  .max(1000)
  .refine(
    (s) =>
      /^(https:\/\/|git:|file:|observation:)/.test(s) &&
      !/^https:\/\/[^/]*@/.test(s),
  );
export const targetSchema = z
  .object({
    id,
    name: z.string().min(1).max(191),
    kind: z.enum(["APP", "TOOL", "ENVIRONMENT", "BOOK", "WRITING"]),
    repository: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .nullable(),
    appId: z.string().max(191).nullable(),
    policySha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    enabled: z.boolean(),
  })
  .strict();
export const observationSchema = z
  .object({
    id,
    targetId: id,
    problemKey: id,
    source: z.string().min(1).max(64),
    summary: text,
    references: z.array(reference).min(1).max(10),
    observedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    waitUntil: z.string().datetime().nullable(),
    samples: z.number().int().nonnegative().max(1000000000),
    minSamples: z.number().int().positive().max(1000000000),
  })
  .strict()
  .refine((o) => Date.parse(o.expiresAt) > Date.parse(o.observedAt));
export const bindingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("git"),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      designPath: relative,
      testPlanPath: relative,
      designSha256: sha,
      testPlanSha256: sha,
    })
    .strict(),
  z
    .object({
      kind: z.literal("files"),
      files: z
        .array(z.object({ path: relative, sha256: sha }).strict())
        .min(1)
        .max(30),
    })
    .strict(),
]);
const argv = z.array(z.string().min(1).max(1000)).min(1).max(30);
export const verificationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("github-pr"),
      repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("files"),
      files: z
        .array(z.object({ path: relative, sha256: sha }).strict())
        .min(1)
        .max(30),
    })
    .strict(),
  z
    .object({
      kind: z.literal("readback"),
      argv,
      expectedText: z.string().min(1).max(3000),
    })
    .strict(),
]);
export const proposalSchema = z
  .object({
    targetId: id,
    problemKey: id,
    title: z.string().min(1).max(191),
    problem: text,
    observationIds: z.array(id).min(1).max(20),
    scope: text,
    design: text,
    preview: text,
    acceptance: z.array(text).min(1).max(30),
    tests: text,
    testCommands: z.array(argv).min(1).max(10),
    verification: verificationSchema,
    tools: z
      .array(
        z.enum([
          "codex",
          "claude",
          "gemini",
          "mcode",
          "git",
          "github",
          "browser",
          "provider",
          "python",
        ]),
      )
      .min(1)
      .max(10),
    executor: z.literal("codex").default("codex"),
    timeLimitMinutes: z.number().int().min(5).max(480),
    impact: z.number().int().min(1).max(5),
    confidence: z.number().min(0).max(1),
    effortMinutes: z.number().int().min(1).max(480),
    deadline: z.string().datetime().nullable(),
    release: z
      .object({
        markets: z
          .array(
            z.enum([
              "service",
              "web",
              "google-play",
              "app-store",
              "apps-in-toss",
            ]),
          )
          .min(1),
        until: z.enum(["test-track", "review-submitted", "public"]),
      })
      .strict()
      .nullable(),
    binding: bindingSchema,
  })
  .strict();
export type ProposalInput = z.infer<typeof proposalSchema>;
export const decisionSchema = z
  .object({
    version: z.number().int().positive(),
    digest: sha,
    decision: z.enum(["approve", "snooze", "exclude", "cancel", "reconcile"]),
    evidence: z.array(reference).max(20).optional(),
  })
  .strict();
export const reportSchema = z
  .object({
    requestId: id,
    generation: z.number().int().positive(),
    kind: z.enum(["heartbeat", "checkpoint", "succeeded", "paused", "stopped"]),
    sessionId: z
      .string()
      .regex(/^[a-f0-9-]{36}$/)
      .nullable(),
    summary: z.string().min(1).max(3000),
    evidence: z.array(reference).max(20),
    checkpoint: z
      .record(
        z.string(),
        z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]),
      )
      .default({}),
  })
  .strict();
export type ReportInput = z.infer<typeof reportSchema>;
export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export class SupervisorError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
export function ensure(
  condition: unknown,
  code: string,
  status = 409,
): asserts condition {
  if (!condition) throw new SupervisorError(code, status);
}
