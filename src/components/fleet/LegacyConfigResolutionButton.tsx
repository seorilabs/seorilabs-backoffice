"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { LegacyConfigResolutionRequest } from "@/lib/control-plane/contracts";
import {
  LEGACY_RESOLUTION_TARGETS_BY_REASON,
  legacyResolutionJustification,
  nextLegacyResolutionTargets,
  suggestedLegacyResolutionTargets,
} from "@/lib/control-plane/legacy-config-resolution-selection";
import { approveLegacyConfigResolutionAction } from "@/lib/actions/legacy-config-resolution";
import { legacyEvidenceLabel } from "@/lib/control-plane/presentation";

type ReasonCode = LegacyConfigResolutionRequest["dispositions"][number]["reasonCode"];
type Target = LegacyConfigResolutionRequest["dispositions"][number]["targets"][number];

export function LegacyConfigResolutionButton({
  appId,
  repoId,
  sourceSha,
  legacyImportId,
  activeConfigRevision,
  expectedResolutionRevision,
  reasonCodes,
  availableEvidenceKinds,
}: {
  appId: string;
  repoId: string;
  sourceSha: string;
  legacyImportId: string;
  activeConfigRevision: number;
  expectedResolutionRevision: number;
  reasonCodes: ReasonCode[];
  availableEvidenceKinds: Target[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const available = useMemo(() => new Set(availableEvidenceKinds), [availableEvidenceKinds]);
  const [selected, setSelected] = useState<Record<string, Target[]>>(() => Object.fromEntries(
    reasonCodes.map((reasonCode) => [
      reasonCode,
      suggestedLegacyResolutionTargets(reasonCode, available),
    ]),
  ));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const complete = reasonCodes.every((reasonCode) => (selected[reasonCode]?.length ?? 0) > 0);

  function toggle(reasonCode: ReasonCode, target: Target) {
    setSelected((current) => {
      const targets = nextLegacyResolutionTargets(current[reasonCode] ?? [], target);
      return { ...current, [reasonCode]: targets };
    });
  }

  function approve() {
    if (!complete || pending) return;
    const confirmed = window.confirm(
      `소스 ${sourceSha.slice(0, 12)}와 적용 설정 버전 ${activeConfigRevision}의 중앙 설정으로 기존 설정을 대체하도록 승인합니다. 소스나 중앙 설정이 바뀌면 이 승인은 자동으로 무효화됩니다. 계속할까요?`,
    );
    if (!confirmed) return;
    setError("");
    setMessage("");
    startTransition(async () => {
      const dispositions = reasonCodes.map((reasonCode) => ({
        reasonCode,
        targets: selected[reasonCode] ?? [],
      }));
      const result = await approveLegacyConfigResolutionAction({
        appId,
        requestId: crypto.randomUUID(),
        request: {
          schemaVersion: 1,
          repoId,
          legacyImportId,
          expectedResolutionRevision,
          expectedActiveConfigRevision: activeConfigRevision,
          dispositions,
          justification: legacyResolutionJustification(dispositions),
        },
      });
      if (!result.ok) {
        setError(result.error ?? "승인을 기록하지 못했습니다.");
        return;
      }
      setMessage(`검토 버전 ${result.revision}을 새 이력으로 기록했습니다. 다음 전체 앱 설정 비교에서 다시 확인합니다.`);
      router.refresh();
    });
  }

  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs">
      <div className="font-medium text-amber-950">기존 설정의 검토 결과 연결</div>
      <p className="mt-1 leading-relaxed text-amber-900">
        원본 값이나 필드 경로는 저장하지 않습니다. 검토 사유마다 대체할 중앙 설정을 연결한 뒤 관리자만 승인할 수 있습니다.
      </p>
      <div className="mt-3 space-y-2">
        {reasonCodes.map((reasonCode) => (
          <div key={reasonCode} className="rounded border border-amber-200 bg-white p-2">
            <div className="font-mono text-[11px] font-medium text-neutral-800">{reasonCode}</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {LEGACY_RESOLUTION_TARGETS_BY_REASON[reasonCode].map((target) => {
                const evidenceAvailable = target === "IGNORED_NON_OPERATIONAL" || available.has(target);
                const checked = selected[reasonCode]?.includes(target) ?? false;
                return (
                  <label key={target} className={`flex items-center gap-1 rounded border px-2 py-1 ${evidenceAvailable ? "border-neutral-200 text-neutral-700" : "border-neutral-100 text-neutral-300"}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={pending || !evidenceAvailable}
                      onChange={() => toggle(reasonCode, target)}
                    />
                    {legacyEvidenceLabel(target)}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={pending || !complete}
        onClick={approve}
        className="mt-3 rounded bg-amber-900 px-3 py-1.5 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "기록 중…" : `중앙 설정으로 대체 승인 · 검토 버전 ${expectedResolutionRevision + 1}`}
      </button>
      {!complete && <p className="mt-2 text-red-700">필수 확인 기록이 없습니다. 설정·정책 정보, 외부 서비스 확인, 계정 연결을 먼저 완료하세요.</p>}
      {message && <p className="mt-2 text-emerald-700">{message}</p>}
      {error && <p className="mt-2 text-red-700">{error}</p>}
    </div>
  );
}
