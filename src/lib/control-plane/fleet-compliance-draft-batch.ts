import { z } from "zod";

import {
  complianceDraftSchema,
  configRevisionPayloadSchema,
  containsCredentialCandidate,
} from "@/lib/control-plane/contracts";
import {
  type FleetComplianceDraftQueueState,
} from "@/lib/control-plane/fleet-compliance-draft-queue";
import { FLEET_COMPLIANCE_DRAFT_BATCH_LIMIT } from "@/lib/control-plane/fleet-compliance-draft-contract";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";

function hasCredentialCandidate(value: unknown): boolean {
  if (typeof value === "string") return containsCredentialCandidate(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).some(([key, nested]) => (
    /(?:password|passwd|secret|tokens?|apikey|privatekey|credentials?|cookie|totp|recoverycodes?)/i.test(
      key.replace(/[^a-z0-9]/gi, ""),
    )
    || hasCredentialCandidate(nested)
  ));
}

export const humanComplianceDraftSchema = complianceDraftSchema.superRefine((draft, context) => {
  if (typeof draft.draft === "string" && draft.draft.trim().length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["draft"],
      message: "빈 compliance 초안은 저장할 수 없습니다.",
    });
  }
  if (
    draft.draft
    && typeof draft.draft === "object"
    && !Array.isArray(draft.draft)
    && Object.keys(draft.draft).length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["draft"],
      message: "빈 compliance object는 저장할 수 없습니다.",
    });
  }
  if (hasCredentialCandidate(draft.draft)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["draft"],
      message: "Compliance 초안에는 credential 후보를 입력할 수 없습니다.",
    });
  }
});

export const fleetComplianceDraftBatchSelectionSchema = z.object({
  appId: z.string().min(1).max(191),
  repoId: z.string().regex(/^[1-9][0-9]*$/),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  expectedActiveConfigRevision: z.number().int().positive(),
  expectedLatestConfigRevision: z.number().int().positive(),
  requestId: z.string().uuid(),
  complianceDrafts: z.array(humanComplianceDraftSchema).min(1).max(15),
}).strict();

export const fleetComplianceDraftBatchSchema = z.object({
  items: z.array(fleetComplianceDraftBatchSelectionSchema)
    .min(1)
    .max(FLEET_COMPLIANCE_DRAFT_BATCH_LIMIT),
}).strict();

export type FleetComplianceDraftBatchSelection = z.infer<typeof fleetComplianceDraftBatchSelectionSchema>;

export type PreparedFleetComplianceDraftBatchItem = {
  appId: string;
  appSlug: string;
  repoId: bigint;
  repoFullName: string;
  sourceSha: string;
  expectedActiveConfigRevision: number;
  expectedLatestConfigRevision: number;
  requestId: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  mode: "CREATE" | "RESUME";
};

function exactBaseMatches(
  current: FleetComplianceDraftQueueState,
  selection: FleetComplianceDraftBatchSelection,
): boolean {
  return current.appId === selection.appId
    && current.repoId === selection.repoId
    && current.sourceSha === selection.sourceSha
    && current.activeConfigRevision === selection.expectedActiveConfigRevision;
}

export function prepareFleetComplianceDraftBatch(input: {
  queue: readonly FleetComplianceDraftQueueState[];
  selections: readonly FleetComplianceDraftBatchSelection[];
}): PreparedFleetComplianceDraftBatchItem[] {
  const selections = fleetComplianceDraftBatchSchema.parse({ items: input.selections }).items;
  const byAppId = new Map(input.queue.map((item) => [item.appId, item]));
  const seenAppIds = new Set<string>();
  const seenRequestIds = new Set<string>();

  return selections.map((selection) => {
    if (seenAppIds.has(selection.appId) || seenRequestIds.has(selection.requestId)) {
      throw new ControlPlaneError(
        "같은 앱 또는 요청 ID를 Compliance 일괄 입력에 중복 지정할 수 없습니다.",
        409,
        "FLEET_COMPLIANCE_BATCH_DUPLICATE",
      );
    }
    seenAppIds.add(selection.appId);
    seenRequestIds.add(selection.requestId);

    const current = byAppId.get(selection.appId);
    if (!current || !exactBaseMatches(current, selection)) {
      throw new ControlPlaneError(
        "Compliance 입력 대상의 source 또는 중앙 revision이 변경되었습니다. 화면을 새로고침하세요.",
        409,
        "FLEET_COMPLIANCE_BATCH_STALE",
      );
    }
    const drafts = selection.complianceDrafts;
    const enabledMarkets = new Set(current.enabledMarkets);
    if (
      drafts.some((draft) => !enabledMarkets.has(draft.market))
      || [...enabledMarkets].some((market) => !drafts.some((draft) => draft.market === market))
    ) {
      throw new ControlPlaneError(
        "선택한 앱의 enabled market마다 사람이 작성한 Compliance 초안이 하나 이상 필요합니다.",
        409,
        "FLEET_COMPLIANCE_MARKET_COVERAGE_MISSING",
      );
    }
    const payload = configRevisionPayloadSchema.parse({
      ...current.activePayload,
      complianceDrafts: drafts,
    });
    const payloadHash = jsonDigest(payload as unknown as JsonValue);
    const createKey = `ui-compliance-batch-create:${selection.requestId}`;
    const resumable = current.latestRevisionState?.revision === selection.expectedActiveConfigRevision + 1
      && current.latestRevisionState.status === "DRAFT"
      && current.latestRevisionState.idempotencyKey === createKey
      && current.latestRevisionState.payloadHash === payloadHash
      && [selection.expectedActiveConfigRevision, current.latestRevisionState.revision]
        .includes(selection.expectedLatestConfigRevision)
      && current.blockers.every((blocker) => blocker === "LATEST_DRAFT_EXISTS");

    if (!current.eligible && !resumable) {
      throw new ControlPlaneError(
        `Compliance 입력 선행조건이 준비되지 않았습니다: ${current.blockers.join(", ") || "NOT_ELIGIBLE"}`,
        409,
        "FLEET_COMPLIANCE_BATCH_NOT_ELIGIBLE",
      );
    }
    if (
      current.eligible
      && current.latestConfigRevision !== selection.expectedLatestConfigRevision
    ) {
      throw new ControlPlaneError(
        "Compliance 입력 대상의 latest revision이 변경되었습니다. 화면을 새로고침하세요.",
        409,
        "FLEET_COMPLIANCE_BATCH_STALE",
      );
    }

    return {
      appId: current.appId,
      appSlug: current.appSlug,
      repoId: BigInt(current.repoId),
      repoFullName: current.repoFullName,
      sourceSha: current.sourceSha,
      expectedActiveConfigRevision: selection.expectedActiveConfigRevision,
      expectedLatestConfigRevision: resumable
        ? selection.expectedActiveConfigRevision
        : current.latestConfigRevision,
      requestId: selection.requestId,
      payload,
      payloadHash,
      mode: resumable ? "RESUME" : "CREATE",
    };
  });
}
