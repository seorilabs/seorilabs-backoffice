"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { advanceFleetLifecycleStageAction } from "@/lib/actions/fleet-control-plane";
import { lifecycleStageLabel } from "@/lib/control-plane/presentation";
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
          <div className="text-sm font-semibold text-neutral-800">개발·출시 단계 변경</div>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            현재 <span title={stage}>{lifecycleStageLabel(stage)}</span> · 변경 차수 {generation}.
            출시 후보부터는 해당 빌드와 마켓 계정의 확인 결과가 있어야 진행할 수 있습니다.
            단계를 되돌리거나 건너뛰거나, 상태 표시만 바꿔 완료할 수 없습니다.
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
                  setError(result.error ?? "단계 변경을 처리하지 못했습니다.");
                  return;
                }
                setMessage(result.status === "DUPLICATE"
                  ? `이미 반영된 요청입니다. 현재 ${lifecycleStageLabel(result.stage ?? stage)}.`
                  : `${lifecycleStageLabel(result.stage ?? stage)} 단계로 이동했습니다. 변경 차수 ${result.generation}.`);
                router.refresh();
              });
            }}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {lifecycleStageLabel(nextStage)} 단계로 이동
          </button>
        ) : (
          <span className="rounded border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-600">
            {nextStage ? `${lifecycleStageLabel(nextStage)}: 확인 결과 필요` : "마지막 단계"}
          </span>
        )}
      </div>
      {message && <p role="status" className="mt-2 text-sm text-emerald-700">{message}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
