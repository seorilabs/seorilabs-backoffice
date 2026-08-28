import { z } from "zod";
import { ControlPlaneError } from "@/lib/control-plane/service";

const sha40 = z.string().regex(/^[0-9a-f]{40}$/i);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i);

export const marketReadbackSchema = z.object({
  schemaVersion: z.literal(1),
  market: z.enum(["google-play", "app-store", "apps-in-toss"]),
  publicAccountId: z.string().min(1).max(191),
  publicAppId: z.string().min(1).max(255),
  gate: z.enum(["UPLOAD", "PROCESSING", "DEVICE_QA", "REVIEW", "APPROVAL", "DEPLOYMENT", "PUBLIC"]),
  state: z.enum(["QUEUED", "IN_PROGRESS", "SUCCEEDED", "APPROVED", "LIVE", "FAILED", "REJECTED", "HUMAN_REQUIRED"]),
  sourceSha: sha40,
  configRevision: z.number().int().positive(),
  artifactChecksum: sha256,
  providerReference: z.string().min(1).max(512).optional(),
  observedAt: z.coerce.date(),
}).strict();

export type MarketReadback = z.infer<typeof marketReadbackSchema>;

const STATUS_BY_PROVIDER_STATE = {
  QUEUED: "PENDING",
  IN_PROGRESS: "PENDING",
  SUCCEEDED: "PASSED",
  APPROVED: "PASSED",
  LIVE: "PASSED",
  FAILED: "FAILED",
  REJECTED: "FAILED",
  HUMAN_REQUIRED: "HUMAN_REQUIRED",
} as const;

/**
 * provider API/격리 브라우저 readback을 공통 gate 원장으로 바꾼다.
 * expected 공개 identity가 하나라도 다르면 기록하지 않는다.
 */
export function normalizeMarketReadback(input: unknown, expected: {
  market: MarketReadback["market"];
  publicAccountId: string;
  publicAppId: string;
  sourceSha: string;
  configRevision: number;
  artifactChecksum: string;
}) {
  const readback = marketReadbackSchema.parse(input);
  if (
    readback.market !== expected.market
    || readback.publicAccountId !== expected.publicAccountId
    || readback.publicAppId !== expected.publicAppId
  ) {
    throw new ControlPlaneError("provider account/team/workspace 또는 app identity가 일치하지 않습니다.", 409, "PROVIDER_IDENTITY_MISMATCH");
  }
  if (
    readback.sourceSha.toLowerCase() !== expected.sourceSha.toLowerCase()
    || readback.configRevision !== expected.configRevision
    || readback.artifactChecksum.toLowerCase() !== expected.artifactChecksum.toLowerCase()
  ) {
    throw new ControlPlaneError("provider readback이 release candidate와 일치하지 않습니다.", 409, "CANDIDATE_BINDING_MISMATCH");
  }
  return {
    gate: readback.gate,
    status: STATUS_BY_PROVIDER_STATE[readback.state],
    observedAt: readback.observedAt,
    evidence: {
      schemaVersion: 1 as const,
      sourceSha: readback.sourceSha.toLowerCase(),
      configRevision: readback.configRevision,
      artifactChecksum: readback.artifactChecksum.toLowerCase(),
      providerReference: readback.providerReference,
      publicIdentity: `${readback.publicAccountId}/${readback.publicAppId}`,
    },
  };
}
