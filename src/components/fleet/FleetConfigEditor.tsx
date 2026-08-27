"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  activateFleetConfigRevisionAction,
  createFleetConfigDraftAction,
  validateFleetConfigDraftAction,
} from "@/lib/actions/fleet-control-plane";

interface DraftSummary {
  revision: number;
  payloadHash: string;
  createdBy: string;
  createdAt: string;
}

export function FleetConfigEditor({
  appId,
  activeRevision,
  initialPayload,
  drafts,
}: {
  appId: string;
  activeRevision: number;
  initialPayload: string;
  drafts: DraftSummary[];
}) {
  const [payload, setPayload] = useState(initialPayload);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function run(action: () => Promise<{ ok: boolean; error?: string; revision?: number; status?: string }>, success: (result: { revision?: number; status?: string }) => string) {
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
        <label className="block text-sm font-semibold text-neutral-800" htmlFor="fleet-config-payload">
          비민감 desired state JSON
        </label>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          법적 선언, 계정 소유권, 결제·세금·은행·계약, 심사 제출, 공개 배포,
          credential 변경 필드는 별도 사람 승인 workflow가 없어 저장과 활성화가 모두 차단됩니다.
        </p>
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
              </div>
              <button
                type="button"
                disabled={pending}
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
                ACTIVE 전환
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
