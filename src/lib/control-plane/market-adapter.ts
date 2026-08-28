import { ControlPlaneError } from "@/lib/control-plane/service";
import { marketReadbackSchema, type MarketReadback } from "@/lib/control-plane/contracts";

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
