"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { approveProviderExecutionAction } from "@/lib/actions/fleet-control-plane";

export function ProviderExecutionApprovalButton({
  appId,
  executionId,
  generation,
  bindingHash,
}: {
  appId: string;
  executionId: string;
  generation: number;
  bindingHash: string;
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
            const result = await approveProviderExecutionAction({
              appId,
              executionId,
              expectedGeneration: generation,
              bindingHash,
              requestId: crypto.randomUUID(),
            });
            if (!result.ok) {
              setError(result.error ?? "provider 실행 승인 실패");
              return;
            }
            router.refresh();
          });
        }}
        className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
      >
        {pending ? "승인 중…" : "이 실행만 15분 승인"}
      </button>
      {error && <div className="mt-1 max-w-xs text-xs text-red-700">{error}</div>}
    </div>
  );
}
