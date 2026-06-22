"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toggleApproval } from "@/lib/actions/issues";

export function ApprovalControls({
  issueId,
  gate,
}: {
  issueId: string;
  gate: "planning" | "release";
}) {
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function approve() {
    startTransition(async () => {
      await toggleApproval({ issueId, gate, on: false, reason: reason || undefined });
      setReason("");
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="승인 사유(선택)"
        className="w-48 rounded border border-neutral-300 px-2 py-1 text-xs"
      />
      <button
        type="button"
        disabled={pending}
        onClick={approve}
        className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {pending ? "처리중…" : "승인 처리"}
      </button>
    </div>
  );
}
