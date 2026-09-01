import {
  legacyConfigResolutionRequestSchema,
  type LegacyConfigResolutionRequest,
} from "@/lib/control-plane/contracts";
import type { FleetLegacyResolutionQueueItem } from "@/lib/control-plane/fleet-legacy-resolution-queue";
import { legacyResolutionJustification } from "@/lib/control-plane/legacy-config-resolution-selection";
import { ControlPlaneError } from "@/lib/control-plane/service";

export type FleetLegacyResolutionBatchSelection = {
  appId: string;
  repoId: string;
  sourceSha: string;
  legacyImportId: string;
  expectedActiveConfigRevision: number;
  expectedResolutionRevision: number;
  requestId: string;
};

export type PreparedFleetLegacyResolutionBatchItem = {
  appId: string;
  repoFullName: string;
  requestId: string;
  request: LegacyConfigResolutionRequest;
};

function exactSelectionMatches(
  current: FleetLegacyResolutionQueueItem,
  selection: FleetLegacyResolutionBatchSelection,
): boolean {
  return current.appId === selection.appId
    && current.repoId === selection.repoId
    && current.sourceSha === selection.sourceSha
    && current.legacyImportId === selection.legacyImportId
    && current.activeConfigRevision === selection.expectedActiveConfigRevision
    && current.expectedResolutionRevision === selection.expectedResolutionRevision;
}

/**
 * 화면이 본 exact source/config/revision이 그대로이고 중앙 증거가 모두 준비된 항목만
 * 일괄 승인 요청으로 만든다. 하나라도 stale이면 외부 mutation 전에 전체를 거부한다.
 */
export function prepareFleetLegacyResolutionBatch(input: {
  queue: readonly FleetLegacyResolutionQueueItem[];
  selections: readonly FleetLegacyResolutionBatchSelection[];
}): PreparedFleetLegacyResolutionBatchItem[] {
  const byAppId = new Map(input.queue.map((item) => [item.appId, item]));
  const seenAppIds = new Set<string>();
  const seenImportIds = new Set<string>();
  const seenRequestIds = new Set<string>();

  return input.selections.map((selection) => {
    if (
      seenAppIds.has(selection.appId)
      || seenImportIds.has(selection.legacyImportId)
      || seenRequestIds.has(selection.requestId)
    ) {
      throw new ControlPlaneError(
        "같은 앱, import 또는 요청 ID를 일괄 승인에 중복 지정할 수 없습니다.",
        409,
        "LEGACY_RESOLUTION_BATCH_DUPLICATE",
      );
    }
    seenAppIds.add(selection.appId);
    seenImportIds.add(selection.legacyImportId);
    seenRequestIds.add(selection.requestId);

    const current = byAppId.get(selection.appId);
    if (!current || !exactSelectionMatches(current, selection)) {
      throw new ControlPlaneError(
        "Legacy 설정 검토 대상의 source 또는 중앙 revision이 변경되었습니다. 화면을 새로고침하세요.",
        409,
        "LEGACY_RESOLUTION_BATCH_STALE",
      );
    }
    if (!current.reviewable || !current.approvalReady) {
      throw new ControlPlaneError(
        `Legacy 설정 검토에 필요한 중앙 증거가 부족합니다: ${current.missingEvidenceKinds.join(", ") || current.blockers.join(", ")}`,
        409,
        "LEGACY_RESOLUTION_BATCH_EVIDENCE_MISSING",
      );
    }

    return {
      appId: current.appId,
      repoFullName: current.repoFullName,
      requestId: selection.requestId,
      request: legacyConfigResolutionRequestSchema.parse({
        schemaVersion: 1,
        repoId: current.repoId,
        legacyImportId: current.legacyImportId,
        expectedResolutionRevision: current.expectedResolutionRevision,
        expectedActiveConfigRevision: current.activeConfigRevision,
        dispositions: current.suggestedDispositions,
        justification: legacyResolutionJustification(current.suggestedDispositions),
      }),
    };
  });
}
