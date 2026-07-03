"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AppStatus } from "@prisma/client";
import { setAppStatus } from "@/lib/actions/lifecycle";
import { isDisabledAppStatus } from "@/lib/domain/app-visibility";

type WritableStatus = Exclude<AppStatus, "DEPRECATED">;

// 앱 운영 상태 토글. 비활성(DEPRECATED)은 DB 전용 플래그라 UI에서 전환/복구하지 않는다.
const NEXT: Record<WritableStatus, Array<{ to: WritableStatus; label: string; tone: string }>> = {
  ACTIVE: [
    { to: "PAUSED", label: "일시중지", tone: "bg-amber-600 hover:bg-amber-500" },
  ],
  PAUSED: [
    { to: "ACTIVE", label: "운영 재개", tone: "bg-emerald-600 hover:bg-emerald-500" },
  ],
};

export function StatusControl({ appId, status }: { appId: string; status: AppStatus }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (isDisabledAppStatus(status)) return null;

  function change(to: WritableStatus) {
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
