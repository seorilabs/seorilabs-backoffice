import crypto from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";
import { parseStableSemVerTag } from "@/lib/core/stable-semver";
import { normalizeLabels } from "@/lib/domain/labels";
import {
  repositoryDiscoveryTrigger,
  type RepositoryWebhookInput,
} from "@/lib/control-plane/repository-registration";
import type { GhIssueInput } from "@/lib/sync/mirror";
import {
  durableWorkflowBundleCandidateSchema,
  type DurableWorkflowBundleCandidate,
} from "@/lib/control-plane/workflow-bundle-candidate-source";

const CLIENT_REQUEST_MARKER = /<!--\s*bo:req=([0-9a-fA-F-]+)\s*-->/;

export const durableIssueObservationSchema = z.object({
  schemaVersion: z.literal(1),
  number: z.number().int().positive(),
  nodeId: z.string().min(1).max(255),
  title: z.string().max(4_096),
  state: z.string().min(1).max(32),
  stateReason: z.string().max(64).nullable(),
  authorLogin: z.string().max(255).nullable(),
  assigneeLogins: z.array(z.string().min(1).max(255)).max(100),
  labels: z.array(z.string().min(1).max(255)).max(100),
  milestone: z.string().max(255).nullable(),
  isPullRequest: z.boolean(),
  clientRequestId: z.string().regex(/^[0-9a-fA-F-]{1,191}$/).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export type DurableIssueObservation = z.infer<typeof durableIssueObservationSchema>;

export const durableStableTagPushSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("STABLE_TAG_PUSH"),
  ref: z.string().regex(/^refs\/tags\/v[^/]+$/).max(512),
  version: z.string().min(1).max(191),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
}).strict();

export type DurableStableTagPush = z.infer<typeof durableStableTagPushSchema>;

export const durableRepositoryDiscoverySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("REPOSITORY_DISCOVERY"),
  event: z.enum(["push", "repository"]),
  action: z.string().max(64).nullable(),
  organization: z.string().min(1).max(255),
  repository: z.object({
    id: z.number().int().positive().safe(),
    fullName: z.string().min(3).max(255),
    name: z.string().min(1).max(255).nullable(),
    defaultBranch: z.string().min(1).max(255).nullable(),
    archived: z.boolean(),
    private: z.boolean(),
  }).strict(),
  ref: z.string().max(512).nullable(),
  after: z.string().max(191).nullable(),
}).strict();

export type DurableRepositoryDiscovery = z.infer<typeof durableRepositoryDiscoverySchema>;

export interface DurableIngressBinding {
  sourceKey: string;
  event: string;
  action: string | null;
  repoFullName: string;
}

export type AutomationIngressClaimCheck = (
  client?: Pick<Prisma.TransactionClient, "automationIngressEvent">,
) => Promise<void>;

/**
 * webhook 원문 전체나 issue body를 durable inbox에 복제하지 않는다. scheduler가
 * IssueMirror를 재구성하는 데 필요한 공개 field와 Backoffice marker만 allowlist한다.
 */
export function durableIssueObservation(issue: GhIssueInput): DurableIssueObservation {
  const marker = issue.body?.match(CLIENT_REQUEST_MARKER)?.[1] ?? null;
  return durableIssueObservationSchema.parse({
    schemaVersion: 1,
    number: issue.number,
    nodeId: issue.node_id,
    title: issue.title,
    state: issue.state,
    stateReason: issue.state_reason ?? null,
    authorLogin: issue.user?.login ?? null,
    assigneeLogins: (issue.assignees ?? []).map(({ login }) => login),
    labels: normalizeLabels(issue.labels),
    milestone: issue.milestone?.title ?? null,
    isPullRequest: Boolean(issue.pull_request),
    clientRequestId: marker,
    createdAt: new Date(issue.created_at).toISOString(),
    updatedAt: new Date(issue.updated_at).toISOString(),
  });
}

export function durableIssueObservationHash(observation: DurableIssueObservation): string {
  return crypto.createHash("sha256")
    .update(canonicalJson(observation as JsonValue))
    .digest("hex");
}

/**
 * 정식 semver tag 생성만 release-note inbox에 넣는다. snapshot, 삭제, branch push는
 * 릴리스 발행 권한이 없으며 원본 webhook 전체를 durable payload로 보존하지 않는다.
 */
export function durableStableTagPush(input: {
  ref?: string | null;
  created?: boolean | null;
  deleted?: boolean | null;
  after?: string | null;
}): DurableStableTagPush | null {
  const ref = input.ref ?? "";
  if (!input.created || input.deleted || !ref.startsWith("refs/tags/")) return null;
  const version = ref.slice("refs/tags/".length);
  if (!parseStableSemVerTag(version)) return null;
  const parsed = durableStableTagPushSchema.safeParse({
    schemaVersion: 1,
    kind: "STABLE_TAG_PUSH",
    ref,
    version,
    headSha: input.after,
  });
  return parsed.success ? parsed.data : null;
}

export function durableStableTagPushHash(observation: DurableStableTagPush): string {
  return crypto.createHash("sha256")
    .update(canonicalJson(observation as JsonValue))
    .digest("hex");
}

/**
 * GitHub가 실패 delivery를 자동 재전송하지 않아도 scheduler가 repository registration을
 * 재구성할 수 있도록 공개 repository identity와 ref/SHA만 봉인한다.
 */
export function durableRepositoryDiscovery(input: {
  event: string;
  action?: string | null;
  repository?: Partial<RepositoryWebhookInput> | null;
  ref?: string | null;
  after?: string | null;
  organization: string;
}): DurableRepositoryDiscovery | null {
  const repository = input.repository;
  if (
    (input.event !== "push" && input.event !== "repository")
    || !Number.isSafeInteger(repository?.id)
    || Number(repository?.id) <= 0
    || !repository?.full_name?.startsWith(`${input.organization}/`)
  ) return null;
  const archived = repository.archived === true
    || input.action === "archived"
    || input.action === "deleted";
  const trigger = repositoryDiscoveryTrigger({
    event: input.event,
    action: input.action ?? undefined,
    defaultBranch: repository.default_branch,
    ref: input.ref ?? undefined,
    after: input.after ?? undefined,
  });
  if (!trigger.relevant && !archived) return null;
  return durableRepositoryDiscoverySchema.parse({
    schemaVersion: 1,
    kind: "REPOSITORY_DISCOVERY",
    event: input.event,
    action: input.action ?? null,
    organization: input.organization,
    repository: {
      id: repository.id,
      fullName: repository.full_name,
      name: repository.name ?? null,
      defaultBranch: repository.default_branch ?? null,
      archived: repository.archived === true,
      private: repository.private === true,
    },
    ref: input.ref ?? null,
    after: input.after ?? null,
  });
}

export function durableIngressEnvelopeHash(input: DurableIngressBinding & {
  payload: DurableIssueObservation | DurableStableTagPush | DurableRepositoryDiscovery | DurableWorkflowBundleCandidate;
}): string {
  return crypto.createHash("sha256")
    .update(canonicalJson({
      sourceKey: input.sourceKey,
      event: input.event,
      action: input.action,
      repoFullName: input.repoFullName.toLowerCase(),
      payload: input.payload,
    } as JsonValue))
    .digest("hex");
}

export function parseDurableIssueObservation(input: {
  payload: unknown;
  payloadHash: string | null;
} & DurableIngressBinding): DurableIssueObservation | null {
  if (input.payload === null || input.payload === undefined) return null;
  const observation = durableIssueObservationSchema.parse(input.payload);
  if (!input.payloadHash || durableIngressEnvelopeHash({ ...input, payload: observation }) !== input.payloadHash) {
    throw new Error("automation inbox payload checksum mismatch");
  }
  return observation;
}

export function parseDurableStableTagPush(input: {
  payload: unknown;
  payloadHash: string | null;
} & DurableIngressBinding): DurableStableTagPush {
  const observation = durableStableTagPushSchema.parse(input.payload);
  if (!input.payloadHash || durableIngressEnvelopeHash({ ...input, payload: observation }) !== input.payloadHash) {
    throw new Error("automation inbox payload checksum mismatch");
  }
  return observation;
}

export function parseDurableRepositoryDiscovery(input: {
  payload: unknown;
  payloadHash: string | null;
} & DurableIngressBinding): DurableRepositoryDiscovery {
  const observation = durableRepositoryDiscoverySchema.parse(input.payload);
  if (
    observation.event !== input.event
    || observation.action !== input.action
    || observation.repository.fullName.toLowerCase() !== input.repoFullName.toLowerCase()
    || !input.payloadHash
    || durableIngressEnvelopeHash({ ...input, payload: observation }) !== input.payloadHash
  ) {
    throw new Error("automation inbox repository discovery binding mismatch");
  }
  return observation;
}

export function parseDurableWorkflowBundleCandidate(input: {
  payload: unknown;
  payloadHash: string | null;
} & DurableIngressBinding): DurableWorkflowBundleCandidate {
  const observation = durableWorkflowBundleCandidateSchema.parse(input.payload);
  if (
    input.event !== "workflow_run"
    || input.action !== "completed"
    || input.repoFullName !== observation.repository
    || !input.payloadHash
    || durableIngressEnvelopeHash({ ...input, payload: observation }) !== input.payloadHash
  ) throw new Error("WORKFLOW_BUNDLE_CANDIDATE_INGRESS_BINDING_MISMATCH");
  return observation;
}

export function durableIssueToMirrorInput(observation: DurableIssueObservation): GhIssueInput {
  return {
    number: observation.number,
    node_id: observation.nodeId,
    title: observation.title,
    state: observation.state,
    state_reason: observation.stateReason,
    body: observation.clientRequestId ? `<!-- bo:req=${observation.clientRequestId} -->` : null,
    user: observation.authorLogin ? { login: observation.authorLogin } : null,
    assignees: observation.assigneeLogins.map((login) => ({ login })),
    labels: observation.labels,
    milestone: observation.milestone ? { title: observation.milestone } : null,
    pull_request: observation.isPullRequest ? {} : undefined,
    created_at: observation.createdAt,
    updated_at: observation.updatedAt,
  };
}
