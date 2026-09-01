"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { markTrustedLocalPendingAction } from "@/lib/actions/fleet-control-plane";

export function TrustedLocalPendingButton({
  appId,
  requestId,
  generation,
}: {
  appId: string;
  requestId: string;
  generation: number;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="text-right">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await markTrustedLocalPendingAction({
              appId,
              reauthRequestId: requestId,
              expectedGeneration: generation,
              requestId: crypto.randomUUID(),
            });
            if (!result.ok) {
              setError(result.error ?? "내 기기에서 로그인 대기 상태로 바꾸지 못했습니다.");
              return;
            }
            router.refresh();
          });
        }}
        className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
      >
        {pending ? "기록 중…" : "내 기기에서 로그인 대기로 표시"}
      </button>
      {error && <div className="mt-1 max-w-xs text-xs text-red-700">{error}</div>}
    </div>
  );
}
