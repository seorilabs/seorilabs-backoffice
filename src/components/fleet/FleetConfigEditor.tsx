"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  activateFleetConfigRevisionAction,
  createFleetConfigDraftAction,
  importLegacyShadowAction,
  validateFleetConfigDraftAction,
} from "@/lib/actions/fleet-control-plane";

interface DraftSummary {
  revision: number;
  payloadHash: string;
  createdBy: string;
  createdAt: string;
  activatable: boolean;
  activationLabel: string;
}

export function FleetConfigEditor({
  appId,
  activeRevision,
  initialPayload,
  legacyActiveBlocked,
  shadowSourceSha,
  drafts,
}: {
  appId: string;
  activeRevision: number;
  initialPayload: string;
  legacyActiveBlocked: boolean;
  shadowSourceSha: string | null;
  drafts: DraftSummary[];
}) {
  const [payload, setPayload] = useState(initialPayload);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function run(
    action: () => Promise<{
      ok: boolean;
      error?: string;
      revision?: number;
      status?: string;
      parityStatus?: string | null;
    }>,
    success: (result: { revision?: number; status?: string; parityStatus?: string | null }) => string,
  ) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "요청을 처리하지 못했습니다.");
        return;
      }
      setMessage(success(result));
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="mb-4 rounded border border-neutral-200 bg-neutral-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-neutral-800">Legacy JSON shadow 관측</div>
              <p className="mt-1 text-xs text-neutral-500">
                최신 Discovery SHA를 GitHub default branch와 다시 대조해 원문 없이 DRAFT와 parity만 기록합니다.
              </p>
            </div>
            <button
              type="button"
              disabled={pending || !shadowSourceSha}
              onClick={() => shadowSourceSha && run(
                () => importLegacyShadowAction({
                  appId,
                  sourceSha: shadowSourceSha,
                  requestId: crypto.randomUUID(),
                }),
                (result) => result.status === "DRAFT_CREATED"
                  ? `Shadow import 완료 · DRAFT revision ${result.revision} · parity ${result.parityStatus ?? "없음"}`
                  : `Shadow import ${result.status ?? "완료"} · 사람 입력이 필요합니다.`,
              )}
              className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              {shadowSourceSha ? "최신 SHA shadow import" : "Discovery 관측 필요"}
            </button>
          </div>
        </div>
        <label className="block text-sm font-semibold text-neutral-800" htmlFor="fleet-config-payload">
          비민감 desired state JSON
        </label>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          이 화면은 market/localization/asset, build pin, support URL, 공개 identity 기반 ProjectBlueprint,
          사람 승인 전 compliance draft만 허용합니다. 비밀값과 법적 승인·심사 제출·공개 배포 필드는 저장과 활성화가 모두 차단됩니다.
        </p>
        {legacyActiveBlocked && (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            기존 ACTIVE revision은 현재 strict 계약 밖의 payload라 편집 원본으로 복사하지 않았습니다. 서명 snapshot 조회는 유지되지만 재활성화할 수 없습니다.
          </p>
        )}
        <textarea
          id="fleet-config-payload"
          value={payload}
          onChange={(event) => setPayload(event.target.value)}
          spellCheck={false}
          className="mt-3 min-h-64 w-full rounded-md border border-neutral-300 bg-neutral-950 p-3 font-mono text-xs leading-relaxed text-neutral-100"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => run(
              () => validateFleetConfigDraftAction({ appId, payloadText: payload }),
              () => "동일한 control-plane validator를 통과했습니다. 아직 저장되지 않았습니다.",
            )}
            className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            검증
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(
              () => createFleetConfigDraftAction({
                appId,
                payloadText: payload,
                requestId: crypto.randomUUID(),
              }),
              (result) => `DRAFT revision ${result.revision}을 생성했습니다.`,
            )}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            DRAFT 생성
          </button>
          {pending && <span className="self-center text-xs text-neutral-500">처리 중…</span>}
        </div>
        {message && <p role="status" className="mt-2 text-sm text-emerald-700">{message}</p>}
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-neutral-800">활성화 대기 DRAFT</h3>
          <span className="text-xs text-neutral-500">현재 ACTIVE revision {activeRevision || "없음"}</span>
        </div>
        <div className="mt-3 divide-y divide-neutral-100 rounded border border-neutral-200">
          {drafts.map((draft) => (
            <div key={draft.revision} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
              <div>
                <div className="text-sm font-medium text-neutral-800">revision {draft.revision}</div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  {draft.createdBy} · {draft.createdAt} · digest {draft.payloadHash.slice(0, 12)}…
                </div>
                {!draft.activatable && (
                  <div className="mt-1 text-xs font-medium text-amber-700">{draft.activationLabel}</div>
                )}
              </div>
              <button
                type="button"
                disabled={pending || !draft.activatable}
                onClick={() => run(
                  () => activateFleetConfigRevisionAction({
                    appId,
                    revision: draft.revision,
                    expectedActiveRevision: activeRevision,
                    requestId: crypto.randomUUID(),
                  }),
                  (result) => `revision ${result.revision}을 ACTIVE로 전환했습니다.`,
                )}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {draft.activationLabel}
              </button>
            </div>
          ))}
          {drafts.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-neutral-400">활성화 대기 DRAFT가 없습니다.</div>
          )}
        </div>
      </div>
    </div>
  );
}
