"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { COMPLIANCE_DECLARATIONS } from "@/components/fleet/config-form";
import { createAndActivateFleetComplianceDraftBatchAction } from "@/lib/actions/fleet-compliance-draft";
import { FLEET_COMPLIANCE_DRAFT_BATCH_LIMIT } from "@/lib/control-plane/fleet-compliance-draft-contract";
import type {
  FleetComplianceDraftBlocker,
  FleetComplianceDraftQueueItem,
} from "@/lib/control-plane/fleet-compliance-draft-queue";

type DraftRow = {
  market: string;
  declaration: typeof COMPLIANCE_DECLARATIONS[number];
  text: string;
  evidenceRef: string;
};

const inputClass = "w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-900 focus:border-neutral-500 focus:outline-none";

const blockerLabel: Record<FleetComplianceDraftBlocker, string> = {
  APP_IDENTITY_CHANGED: "앱·저장소 identity 변경",
  ACTIVE_CONFIG_MISSING: "ACTIVE 설정 없음",
  ACTIVE_PAYLOAD_INVALID: "ACTIVE payload 오류",
  ACTIVE_COMPLIANCE_PROJECTION_DRIFT: "Compliance projection 불일치",
  ACTIVE_REVISION_CHANGED: "ACTIVE revision 변경",
  CURRENT_DISCOVERY_MISSING: "현재 discovery 없음",
  SOURCE_SHA_CHANGED: "source SHA 변경",
  ENABLED_MARKET_MISSING: "활성 market 없음",
  LATEST_DRAFT_EXISTS: "기존 미완료 DRAFT 있음",
};

function initialRows(item: FleetComplianceDraftQueueItem): DraftRow[] {
  return item.enabledMarkets.map((market) => ({
    market,
    declaration: "privacy",
    text: "",
    evidenceRef: "",
  }));
}

function initialRowsByApp(items: FleetComplianceDraftQueueItem[]): Record<string, DraftRow[]> {
  return Object.fromEntries(items.map((item) => [item.appId, initialRows(item)]));
}

export function FleetComplianceDraftBatch({
  items,
}: {
  items: FleetComplianceDraftQueueItem[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [requestIds, setRequestIds] = useState<Record<string, string>>({});
  const [rowsByApp, setRowsByApp] = useState<Record<string, DraftRow[]>>(() => initialRowsByApp(items));
  const [sharedDeclaration, setSharedDeclaration] = useState<typeof COMPLIANCE_DECLARATIONS[number]>("privacy");
  const [sharedText, setSharedText] = useState("");
  const [sharedEvidenceRef, setSharedEvidenceRef] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const currentIds = new Set(items.map((item) => item.appId));
    setRowsByApp((current) => Object.fromEntries(items.map((item) => [
      item.appId,
      current[item.appId] ?? initialRows(item),
    ])));
    setSelected((current) => new Set([...current].filter((appId) => currentIds.has(appId))));
    setRequestIds((current) => Object.fromEntries(
      Object.entries(current).filter(([appId]) => currentIds.has(appId)),
    ));
  }, [items]);

  const readyItems = useMemo(() => items.filter((item) => item.eligible), [items]);
  const selectedItems = items.filter((item) => selected.has(item.appId));
  const selectedRowsComplete = selectedItems.every((item) => (
    (rowsByApp[item.appId]?.length ?? 0) > 0
    && rowsByApp[item.appId]!.every((row) => row.text.trim().length > 0)
  ));

  function toggle(item: FleetComplianceDraftQueueItem) {
    if (!item.eligible && !selected.has(item.appId)) return;
    if (
      !selected.has(item.appId)
      && selected.size >= FLEET_COMPLIANCE_DRAFT_BATCH_LIMIT
    ) {
      setError(`한 번에 최대 ${FLEET_COMPLIANCE_DRAFT_BATCH_LIMIT}개 앱만 선택할 수 있습니다.`);
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(item.appId)) next.delete(item.appId);
      else next.add(item.appId);
      return next;
    });
    setError("");
    setRequestIds((current) => (
      current[item.appId]
        ? current
        : { ...current, [item.appId]: crypto.randomUUID() }
    ));
  }

  function updateRow(appId: string, index: number, patch: Partial<DraftRow>) {
    setRowsByApp((current) => ({
      ...current,
      [appId]: (current[appId] ?? []).map((row, rowIndex) => (
        rowIndex === index ? { ...row, ...patch } : row
      )),
    }));
  }

  function applySharedDraft() {
    if (selectedItems.length === 0) {
      setError("공통 초안을 적용할 앱을 먼저 선택하세요.");
      return;
    }
    if (!sharedText.trim()) {
      setError("사람이 확인한 공통 초안 내용을 입력하세요.");
      return;
    }
    setRowsByApp((current) => {
      const next = { ...current };
      for (const item of selectedItems) {
        next[item.appId] = (current[item.appId] ?? initialRows(item)).map((row) => ({
          ...row,
          declaration: sharedDeclaration,
          text: sharedText,
          evidenceRef: sharedEvidenceRef,
        }));
      }
      return next;
    });
    setError("");
    setMessage(`${selectedItems.length}개 앱의 활성 market 입력란에 공통 초안을 복사했습니다. 앱별 사실을 다시 확인하세요.`);
  }

  function submit() {
    if (pending || selectedItems.length === 0) return;
    if (!selectedRowsComplete) {
      setError("선택한 앱의 모든 활성 market에 사람이 확인한 초안을 입력하세요.");
      return;
    }
    const repositories = selectedItems.map((item) => item.repoFullName).join("\n- ");
    const confirmed = window.confirm(
      `${selectedItems.length}개 앱의 Compliance 초안을 새 ConfigRevision으로 만들고 즉시 ACTIVE로 전환합니다.\n\n- ${repositories}\n\n이 동작은 법적 승인이나 마켓 제출이 아니며, 입력한 초안이 정확하다는 사람 확인만 기록합니다. 계속할까요?`,
    );
    if (!confirmed) return;
    setMessage("");
    setError("");
    const stableRequestIds = { ...requestIds };
    for (const item of selectedItems) {
      stableRequestIds[item.appId] ??= crypto.randomUUID();
    }
    setRequestIds(stableRequestIds);
    startTransition(async () => {
      const result = await createAndActivateFleetComplianceDraftBatchAction({
        items: selectedItems.map((item) => ({
          appId: item.appId,
          repoId: item.repoId,
          sourceSha: item.sourceSha,
          expectedActiveConfigRevision: item.activeConfigRevision,
          expectedLatestConfigRevision: item.latestConfigRevision,
          requestId: stableRequestIds[item.appId]!,
          complianceDrafts: (rowsByApp[item.appId] ?? []).map((row) => ({
            market: row.market as "google-play" | "app-store" | "apps-in-toss",
            declaration: row.declaration,
            state: "DRAFT" as const,
            draft: row.text,
            ...(row.evidenceRef.trim() ? { evidenceRef: row.evidenceRef.trim() } : {}),
          })),
        })),
      });
      if (result.completedCount > 0) {
        setMessage(`${result.completedCount}개 앱의 signed ACTIVE revision을 기록했습니다. 다음 parity wave에서 재검증합니다.`);
      }
      if (!result.ok) {
        const failures = result.results
          .filter((item) => !item.ok)
          .map((item) => `${item.repoFullName} [${item.stage}${item.revision ? ` revision ${item.revision}` : ""}]: ${item.error ?? "실패"}`)
          .join(" / ");
        setError([result.error, failures].filter(Boolean).join(" ") || "Compliance 일괄 입력을 완료하지 못했습니다.");
      }
      router.refresh();
    });
  }

  if (items.length === 0) {
    return <p className="text-xs text-neutral-500">현재 Compliance 입력을 기다리는 Fleet 앱은 없습니다.</p>;
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="rounded border border-amber-200 bg-amber-50 p-3 text-amber-950">
        <div className="font-semibold">사람 전용 Compliance 초안</div>
        <p className="mt-1 leading-relaxed">
          법적 사실을 자동 추정하지 않습니다. 비밀번호·키·토큰은 입력하지 말고, 실제 확인한 초안만 기록하세요.
          새 revision 생성과 signed ACTIVE 전환은 한 번의 확인으로 실행되지만 심사 제출·승인·공개 배포는 하지 않습니다.
        </p>
      </div>

      <div className="grid gap-2 rounded border border-neutral-200 bg-neutral-50 p-3 md:grid-cols-[180px_1fr_1fr_auto]">
        <label>
          <span className="mb-1 block font-medium text-neutral-600">공통 declaration</span>
          <select
            className={inputClass}
            value={sharedDeclaration}
            onChange={(event) => setSharedDeclaration(event.target.value as typeof sharedDeclaration)}
          >
            {COMPLIANCE_DECLARATIONS.map((declaration) => (
              <option key={declaration} value={declaration}>{declaration}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="mb-1 block font-medium text-neutral-600">공통 초안</span>
          <textarea
            className={inputClass}
            rows={2}
            value={sharedText}
            onChange={(event) => setSharedText(event.target.value)}
          />
        </label>
        <label>
          <span className="mb-1 block font-medium text-neutral-600">공통 evidenceRef - 선택</span>
          <input
            className={inputClass}
            type="text"
            autoComplete="off"
            value={sharedEvidenceRef}
            onChange={(event) => setSharedEvidenceRef(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="self-end rounded border border-neutral-300 bg-white px-3 py-1.5 font-medium text-neutral-700 hover:bg-neutral-100"
          onClick={applySharedDraft}
          disabled={pending}
        >
          선택 앱에 복사
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-neutral-500">
        <span>입력 대기 {items.length}개 · 즉시 처리 가능 {readyItems.length}개 · 선택 {selectedItems.length}개</span>
        <span>한 번에 최대 {FLEET_COMPLIANCE_DRAFT_BATCH_LIMIT}개</span>
      </div>

      <div className="space-y-2">
        {items.map((item) => {
          const isSelected = selected.has(item.appId);
          return (
            <article key={item.appId} className={`rounded border p-3 ${isSelected ? "border-blue-300 bg-blue-50" : "border-neutral-200 bg-white"}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <label className="flex min-w-0 items-start gap-2">
                  <input
                    className="mt-0.5"
                    type="checkbox"
                    checked={isSelected}
                    disabled={pending || (!isSelected && (
                      !item.eligible || selectedItems.length >= FLEET_COMPLIANCE_DRAFT_BATCH_LIMIT
                    ))}
                    onChange={() => toggle(item)}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-neutral-800">{item.repoFullName}</span>
                    <span className="block break-all font-mono text-[10px] text-neutral-400">
                      {item.sourceSha.slice(0, 12)} · ACTIVE/latest {item.activeConfigRevision}/{item.latestConfigRevision}
                    </span>
                  </span>
                </label>
                <span className="text-right text-[10px] text-neutral-500">
                  {item.enabledMarkets.join(" · ") || "market 없음"}
                  {item.credentialBindingRequired && <span className="ml-2 font-medium text-amber-700">CredentialBinding도 필요</span>}
                </span>
              </div>
              {item.blockers.length > 0 && (
                <p className="mt-2 text-[11px] font-medium text-red-700">
                  {item.blockers.map((blocker) => blockerLabel[blocker]).join(" · ")}
                </p>
              )}
              {isSelected && (
                <div className="mt-3 grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
                  {(rowsByApp[item.appId] ?? []).map((row, index) => (
                    <div key={row.market} className="rounded border border-blue-200 bg-white p-2">
                      <div className="mb-2 font-medium text-blue-950">{row.market}</div>
                      <label className="block">
                        <span className="mb-1 block text-[10px] font-medium text-neutral-500">declaration</span>
                        <select
                          className={inputClass}
                          value={row.declaration}
                          onChange={(event) => updateRow(item.appId, index, {
                            declaration: event.target.value as DraftRow["declaration"],
                          })}
                        >
                          {COMPLIANCE_DECLARATIONS.map((declaration) => (
                            <option key={declaration} value={declaration}>{declaration}</option>
                          ))}
                        </select>
                      </label>
                      <label className="mt-2 block">
                        <span className="mb-1 block text-[10px] font-medium text-neutral-500">사람 확인 초안</span>
                        <textarea
                          className={inputClass}
                          rows={3}
                          value={row.text}
                          onChange={(event) => updateRow(item.appId, index, { text: event.target.value })}
                        />
                      </label>
                      <label className="mt-2 block">
                        <span className="mb-1 block text-[10px] font-medium text-neutral-500">evidenceRef - 선택</span>
                        <input
                          className={inputClass}
                          type="text"
                          autoComplete="off"
                          value={row.evidenceRef}
                          onChange={(event) => updateRow(item.appId, index, { evidenceRef: event.target.value })}
                        />
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>

      <button
        type="button"
        disabled={pending || selectedItems.length === 0 || !selectedRowsComplete}
        onClick={submit}
        className="rounded bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
      >
        {pending ? "처리 중…" : `선택 ${selectedItems.length}개 DRAFT 생성 및 ACTIVE 전환`}
      </button>
      {message && <p role="status" className="text-emerald-700">{message}</p>}
      {error && <p role="alert" className="text-red-700">{error}</p>}
    </div>
  );
}
