import Link from "next/link";

import { LegacyConfigResolutionButton } from "@/components/fleet/LegacyConfigResolutionButton";
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

  if (items.length === 0) {
    return <p className="text-xs text-emerald-700">현재 사람이 처리할 legacy 설정 gate가 없습니다.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded bg-amber-100 px-2 py-1 text-amber-900">전체 {items.length}건</span>
        <span className="rounded bg-blue-100 px-2 py-1 text-blue-900">검토 양식 {reviewableCount}건</span>
        <span className="rounded bg-neutral-100 px-2 py-1 text-neutral-700">선행 조치 필요 {items.length - reviewableCount}건</span>
      </div>

      {items.map((item) => (
        <details key={`${item.appId}:${item.legacyImportId}`} className="rounded border border-neutral-200 bg-white">
          <summary className="cursor-pointer list-none px-3 py-2 text-sm">
            <span className="font-medium">{item.repoFullName}</span>
            <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] ${item.reviewable ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800"}`}>
              {item.reviewable ? "검토 양식" : "선행 조치 필요"}
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
              Import {item.importStatus} · parity {item.parityStatus ?? "없음"} · ACTIVE revision {item.activeConfigRevision ?? "없음"}
            </div>
            <div className="mt-1 text-[11px] text-neutral-500">
              중앙 증거: {item.availableEvidenceKinds.join(", ") || "없음"}
            </div>

            {item.reviewable && item.activeConfigRevision !== null ? (
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
              앱의 전체 Fleet 증거 보기
            </Link>
          </div>
        </details>
      ))}

      <p className="text-xs leading-relaxed text-neutral-500">
        이 화면은 비밀값과 원문 field path를 읽지 않습니다. 실제 저장은 앱 화면과 동일한 validator,
        optimistic concurrency, append-only audit를 사용하며 source 또는 중앙 상태가 바뀌면 자동 무효화됩니다.
      </p>
    </div>
  );
}
