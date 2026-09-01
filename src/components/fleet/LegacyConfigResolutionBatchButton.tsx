"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { approveLegacyConfigResolutionBatchAction } from "@/lib/actions/legacy-config-resolution";
import type { FleetLegacyResolutionQueueItem } from "@/lib/control-plane/fleet-legacy-resolution-queue";
import { LEGACY_RESOLUTION_BATCH_LIMIT } from "@/lib/control-plane/legacy-config-resolution-selection";

function itemKey(item: FleetLegacyResolutionQueueItem): string {
  return `${item.appId}:${item.legacyImportId}`;
}

export function LegacyConfigResolutionBatchButton({
  items,
}: {
  items: FleetLegacyResolutionQueueItem[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const allReadyItems = useMemo(() => items.filter((item) => item.approvalReady), [items]);
  const readyItems = allReadyItems.slice(0, LEGACY_RESOLUTION_BATCH_LIMIT);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(readyItems.map(itemKey)));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selectedItems = readyItems.filter((item) => selected.has(itemKey(item)));

  if (readyItems.length === 0) {
    return (
      <p className="rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
        현재 일괄 승인 가능한 항목은 없습니다. 아래에 표시된 ComplianceProfile 또는 CredentialBinding을 먼저 준비하세요.
      </p>
    );
  }

  function toggle(item: FleetLegacyResolutionQueueItem) {
    const key = itemKey(item);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function approve() {
    if (pending || selectedItems.length === 0) return;
    const repositories = selectedItems.map((item) => item.repoFullName).join("\n- ");
    const confirmed = window.confirm(
      `${selectedItems.length}개 앱의 exact source와 ACTIVE revision에서 중앙 상태가 legacy 설정을 대체함을 한 번에 승인합니다.\n\n- ${repositories}\n\n각 앱은 독립 CAS와 append-only 감사 기록을 사용하며 변경된 항목은 거부됩니다. 계속할까요?`,
    );
    if (!confirmed) return;
    setMessage("");
    setError("");
    startTransition(async () => {
      const result = await approveLegacyConfigResolutionBatchAction({
        items: selectedItems.map((item) => ({
          appId: item.appId,
          repoId: item.repoId,
          sourceSha: item.sourceSha,
          legacyImportId: item.legacyImportId,
          expectedActiveConfigRevision: item.activeConfigRevision!,
          expectedResolutionRevision: item.expectedResolutionRevision,
          requestId: crypto.randomUUID(),
        })),
      });
      if (result.completedCount > 0) {
        setMessage(`${result.completedCount}건의 append-only resolution을 기록했습니다. 다음 parity wave에서 exact 상태를 재검증합니다.`);
      }
      if (!result.ok) {
        const failures = result.results
          .filter((item) => !item.ok)
          .map((item) => `${item.repoFullName}: ${item.error ?? "실패"}`)
          .join(" / ");
        setError([result.error, failures].filter(Boolean).join(" ") || "일괄 승인을 기록하지 못했습니다.");
      }
      router.refresh();
    });
  }

  return (
    <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs">
      <div className="font-medium text-blue-950">중앙 상태 일괄 승인</div>
      <p className="mt-1 leading-relaxed text-blue-900">
        비밀값이나 legacy 원문을 읽지 않습니다. 선택한 앱마다 현재 source, ACTIVE revision,
        resolution revision과 중앙 증거를 서버가 다시 대조합니다.
      </p>
      {allReadyItems.length > LEGACY_RESOLUTION_BATCH_LIMIT && (
        <p className="mt-1 text-amber-800">
          한 번에 최대 {LEGACY_RESOLUTION_BATCH_LIMIT}건만 처리합니다. 이번 승인 뒤 새로고침하면 다음 항목이 표시됩니다.
        </p>
      )}
      <div className="mt-3 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {readyItems.map((item) => (
          <label key={itemKey(item)} className="flex items-start gap-2 rounded border border-blue-200 bg-white px-2 py-1.5 text-neutral-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={selected.has(itemKey(item))}
              disabled={pending}
              onChange={() => toggle(item)}
            />
            <span>
              <span className="block font-medium">{item.repoFullName}</span>
              <span className="font-mono text-[10px] text-neutral-400">
                {item.sourceSha.slice(0, 12)} · ACTIVE {item.activeConfigRevision}
              </span>
              <span className="mt-0.5 block text-[10px] text-neutral-500">
                {item.suggestedDispositions.map((disposition) => (
                  `${disposition.reasonCode} → ${disposition.targets.join("+")}`
                )).join(" · ")}
              </span>
            </span>
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={pending || selectedItems.length === 0}
        onClick={approve}
        className="mt-3 rounded bg-blue-700 px-3 py-1.5 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "기록 중…" : `선택 ${selectedItems.length}건 일괄 승인`}
      </button>
      {message && <p role="status" className="mt-2 text-emerald-700">{message}</p>}
      {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
    </div>
  );
}
