import type { AppStatus } from "@prisma/client";

export interface FleetProjectionAppBinding {
  status: AppStatus;
  projectV2Id: string | null;
}

export type FleetProjectionBindingDisposition =
  | { kind: "CURRENT" }
  | { kind: "NEEDS_INPUT"; reason: string }
  | { kind: "SUPERSEDED"; reason: string };

/**
 * Projection row가 만들어진 뒤 App의 Fleet Project binding이 바뀔 수 있다.
 * 외부 write 전에 현재 App binding과 row target이 정확히 같은지 판정한다.
 */
export function fleetProjectionBindingDisposition(input: {
  projectNodeId: string;
  app: FleetProjectionAppBinding | null;
}): FleetProjectionBindingDisposition {
  if (!input.app) {
    return { kind: "SUPERSEDED", reason: "Projection app이 삭제되어 더 이상 적용할 수 없습니다." };
  }
  if (input.app.status !== "ACTIVE") {
    return { kind: "SUPERSEDED", reason: "Projection app이 ACTIVE 상태가 아니어서 적용 대상에서 제외되었습니다." };
  }
  if (input.projectNodeId.startsWith("UNCONFIGURED:")) {
    return input.app.projectV2Id
      ? { kind: "SUPERSEDED", reason: "App의 Fleet Project binding이 새로 설정되어 기존 미설정 projection을 폐기했습니다." }
      : { kind: "NEEDS_INPUT", reason: "Seorilabs Fleet Project node ID가 필요합니다." };
  }
  if (!input.app.projectV2Id) {
    return { kind: "SUPERSEDED", reason: "App의 Fleet Project binding이 제거되어 기존 projection을 폐기했습니다." };
  }
  if (input.app.projectV2Id !== input.projectNodeId) {
    return { kind: "SUPERSEDED", reason: "App의 Fleet Project binding이 변경되어 기존 projection을 폐기했습니다." };
  }
  return { kind: "CURRENT" };
}
