import type { FleetProjectSourceDisposition } from "@/lib/control-plane/fleet-project-binding";

export type FleetProjectionBindingDisposition =
  | { kind: "CURRENT" }
  | { kind: "NEEDS_INPUT"; reason: string }
  | { kind: "READBACK_REQUIRED"; reason: string }
  | { kind: "SUPERSEDED"; reason: string };

/**
 * Projection row의 target/revision과 조직 단일 Fleet Project source를 비교한다.
 * 앱별 projectV2Id는 입력에 존재하지 않으며 PRODUCT_APP/source eligibility도
 * 중앙 resolver가 같은 시점의 공개 DB state에서 판정한다.
 */
export function fleetProjectionBindingDisposition(input: {
  projectNodeId: string;
  bindingRevision: number | null;
  source: FleetProjectSourceDisposition;
}): FleetProjectionBindingDisposition {
  if (input.source.kind === "INELIGIBLE") {
    return { kind: "SUPERSEDED", reason: input.source.reason };
  }
  if (input.source.kind === "NEEDS_INPUT") {
    return { kind: "NEEDS_INPUT", reason: input.source.reason };
  }
  if (input.source.kind === "READBACK_REQUIRED") {
    return { kind: "READBACK_REQUIRED", reason: input.source.reason };
  }
  if (
    input.projectNodeId !== input.source.projectNodeId
    || input.bindingRevision !== input.source.bindingRevision
  ) {
    return {
      kind: "SUPERSEDED",
      reason: "조직 Fleet Project target 또는 desired-state revision이 변경되었습니다.",
    };
  }
  return { kind: "CURRENT" };
}
