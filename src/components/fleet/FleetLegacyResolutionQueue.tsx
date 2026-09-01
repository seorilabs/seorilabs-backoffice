import Link from "next/link";
import { legacyEvidenceLabel, managementStatusLabel } from "@/lib/control-plane/presentation";

import { LegacyConfigResolutionButton } from "@/components/fleet/LegacyConfigResolutionButton";
import { LegacyConfigResolutionBatchButton } from "@/components/fleet/LegacyConfigResolutionBatchButton";
import type { FleetLegacyResolutionQueueItem } from "@/lib/control-plane/fleet-legacy-resolution-queue";

function shortSha(value: string): string {
  return value.slice(0, 12);
}

export function FleetLegacyResolutionQueue({
  items,
}: {
  items: FleetLegacyResolutionQueueItem[];
}) {
  const reviewableCount = items.filter((item) => item.reviewable).length;
  const approvalReadyCount = items.filter((item) => item.approvalReady).length;
  const awaitingParityCount = items.filter((item) => item.awaitingParity).length;

  if (items.length === 0) {
    return <p className="text-xs text-emerald-700">현재 검토가 필요한 기존 설정이 없습니다.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded bg-amber-100 px-2 py-1 text-amber-900">전체 {items.length}건</span>
        <span className="rounded bg-blue-100 px-2 py-1 text-blue-900">검토 양식 {reviewableCount}건</span>
        <span className="rounded bg-emerald-100 px-2 py-1 text-emerald-900">승인 가능 {approvalReadyCount}건</span>
        <span className="rounded bg-violet-100 px-2 py-1 text-violet-900">설정 비교 대기 {awaitingParityCount}건</span>
        <span className="rounded bg-neutral-100 px-2 py-1 text-neutral-700">중앙 증거 준비 필요 {reviewableCount - approvalReadyCount - awaitingParityCount}건</span>
        <span className="rounded bg-red-50 px-2 py-1 text-red-700">원본 보정 필요 {items.length - reviewableCount}건</span>
      </div>

      <LegacyConfigResolutionBatchButton items={items} />

      {items.map((item) => (
        <details key={`${item.appId}:${item.legacyImportId}`} className="rounded border border-neutral-200 bg-white">
          <summary className="cursor-pointer list-none px-3 py-2 text-sm">
            <span className="font-medium">{item.repoFullName}</span>
            <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] ${item.approvalReady ? "bg-emerald-100 text-emerald-800" : item.awaitingParity ? "bg-violet-100 text-violet-800" : item.reviewable ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800"}`}>
              {item.approvalReady ? "승인 가능" : item.awaitingParity ? "설정 재비교 대기" : item.reviewable ? "중앙 증거 입력 필요" : "원본 보정 필요"}
            </span>
            <span className="ml-2 font-mono text-[11px] text-neutral-400">{shortSha(item.sourceSha)}</span>
          </summary>
          <div className="border-t border-neutral-100 p-3">
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {item.rawReasonCodes.map((reason) => (
                <span key={reason} className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-neutral-700">{reason}</span>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-neutral-500">
              가져오기 {managementStatusLabel(item.importStatus)} · 비교 {managementStatusLabel(item.parityStatus ?? "없음")} · 적용 설정 버전 {item.activeConfigRevision ?? "없음"}
            </div>
            <div className="mt-1 text-[11px] text-neutral-500">
              중앙 증거: {item.availableEvidenceKinds.map(legacyEvidenceLabel).join(", ") || "없음"}
            </div>
            {item.missingEvidenceKinds.length > 0 && (
              <div className="mt-1 text-[11px] font-medium text-amber-700">
                추가 입력: {item.missingEvidenceKinds.map(legacyEvidenceLabel).join(", ")}
              </div>
            )}

            {item.awaitingParity ? (
              <p className="mt-3 text-xs text-violet-700">
                최신 승인 이력이 기록됐습니다. 다음 전체 앱 설정 비교 결과가 나오기 전에는 중복 승인하지 않습니다.
              </p>
            ) : item.reviewable && item.activeConfigRevision !== null ? (
              <div className="mt-3">
                <LegacyConfigResolutionButton
                  appId={item.appId}
                  repoId={item.repoId}
                  sourceSha={item.sourceSha}
                  legacyImportId={item.legacyImportId}
                  activeConfigRevision={item.activeConfigRevision}
                  expectedResolutionRevision={item.expectedResolutionRevision}
                  reasonCodes={item.reasonCodes}
                  availableEvidenceKinds={item.availableEvidenceKinds}
                />
              </div>
            ) : (
              <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                선행 조치: {item.blockers.join(", ")}
              </div>
            )}

            <Link className="mt-3 inline-block text-xs text-blue-700 underline" href={`/apps/${item.appId}/fleet`}>
              앱 통합 관리에서 전체 확인 기록 보기
            </Link>
          </div>
        </details>
      ))}

      <p className="text-xs leading-relaxed text-neutral-500">
        이 화면은 비밀값과 원본 필드 경로를 읽지 않습니다. 앱 화면과 같은 기준으로 입력과 변경 여부를 확인하고
        승인 이력을 남깁니다. 소스 또는 중앙 설정이 바뀌면 기존 승인은 자동으로 무효화됩니다.
      </p>
    </div>
  );
}
