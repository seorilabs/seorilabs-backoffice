"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { advanceFleetLifecycleStageAction } from "@/lib/actions/fleet-control-plane";
import {
  FLEET_LIFECYCLE_STAGES,
  HUMAN_TRANSITION_STAGES,
  lifecycleStageRank,
} from "@/lib/control-plane/lifecycle-policy";

export function FleetLifecycleControls({
  appId,
  stage,
  generation,
}: {
  appId: string;
  stage: string;
  generation: number;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const currentRank = lifecycleStageRank(stage);
  const nextStage = FLEET_LIFECYCLE_STAGES[currentRank + 1];
  const humanAdvancable = Boolean(nextStage)
    && (HUMAN_TRANSITION_STAGES as readonly string[]).includes(nextStage);

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-neutral-800">중앙 lifecycle 전이</div>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            현재 <span className="font-mono">{stage}</span> · generation {generation}.
            RELEASE_CANDIDATE 이후는 append-only gate observation과 exact provider/public identity 증거로만 전진하며,
            되돌림·건너뜀·라벨 기반 전이는 허용하지 않습니다.
          </p>
        </div>
        {humanAdvancable ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setError(null);
              setMessage(null);
              startTransition(async () => {
                const result = await advanceFleetLifecycleStageAction({
                  appId,
                  toStage: nextStage,
                  expectedGeneration: generation,
                  requestId: crypto.randomUUID(),
                });
                if (!result.ok) {
                  setError(result.error ?? "lifecycle 전이를 처리하지 못했습니다.");
                  return;
                }
                setMessage(result.status === "DUPLICATE"
                  ? `이미 반영된 요청입니다. 현재 ${result.stage}.`
                  : `${result.stage} 단계로 전진했습니다. generation ${result.generation}.`);
                router.refresh();
              });
            }}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {nextStage}(으)로 전진
          </button>
        ) : (
          <span className="rounded border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-600">
            {nextStage ? `${nextStage}은 gate 증거 전용` : "마지막 단계"}
          </span>
        )}
      </div>
      {message && <p role="status" className="mt-2 text-sm text-emerald-700">{message}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
