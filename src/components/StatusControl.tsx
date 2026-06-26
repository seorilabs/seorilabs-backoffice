"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AppStatus } from "@prisma/client";
import { setAppStatus } from "@/lib/actions/lifecycle";

// 앱 운영 상태 토글. 현재 상태에 따라 가능한 전환 버튼만 노출.
const NEXT: Record<AppStatus, Array<{ to: AppStatus; label: string; tone: string }>> = {
  ACTIVE: [
    { to: "DEPRECATED", label: "존치 전환", tone: "bg-neutral-700 hover:bg-neutral-600" },
    { to: "PAUSED", label: "일시중지", tone: "bg-amber-600 hover:bg-amber-500" },
  ],
  PAUSED: [
    { to: "ACTIVE", label: "운영 재개", tone: "bg-emerald-600 hover:bg-emerald-500" },
    { to: "DEPRECATED", label: "존치 전환", tone: "bg-neutral-700 hover:bg-neutral-600" },
  ],
  DEPRECATED: [
    { to: "ACTIVE", label: "운영 재개", tone: "bg-emerald-600 hover:bg-emerald-500" },
  ],
};

export function StatusControl({ appId, status }: { appId: string; status: AppStatus }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function change(to: AppStatus) {
    startTransition(async () => {
      await setAppStatus(appId, to);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {NEXT[status].map((opt) => (
        <button
          key={opt.to}
          type="button"
          disabled={pending}
          onClick={() => change(opt.to)}
          className={`rounded px-3 py-1 text-xs font-medium text-white disabled:opacity-50 ${opt.tone}`}
        >
          {pending ? "처리중…" : opt.label}
        </button>
      ))}
    </div>
  );
}
