"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reconcileNow, seedRegistryAction } from "@/lib/actions/sync";

export function SettingsActions() {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  function run(kind: "reconcile" | "seed") {
    setMsg(null);
    startTransition(async () => {
      try {
        if (kind === "reconcile") {
          const r = await reconcileNow();
          setMsg(`리싱크 완료: ${r.repos}개 레포`);
        } else {
          const r = await seedRegistryAction();
          setMsg(`시드 완료: ${r.seeded} upsert / ${r.skipped} skip / ${r.backfilled} backfill`);
        }
        router.refresh();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "실패");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => run("seed")}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          레지스트리 시드/재스캔
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run("reconcile")}
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50"
        >
          전체 리싱크
        </button>
      </div>
      {pending && <p className="text-xs text-neutral-500">실행 중… (레포 수에 따라 수 분 소요)</p>}
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
    </div>
  );
}
