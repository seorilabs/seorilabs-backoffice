"use client";

import { useState, useTransition } from "react";
import { applyGitHubBootstrapAction, planGitHubBootstrapAction, readGitHubBootstrapAction, reconcileGitHubBootstrapAction } from "@/lib/actions/github-bootstrap";
import type { GitHubBootstrapView } from "@/lib/control-plane/github-bootstrap-service";

const labels: Record<string, string> = {
  "fleet-managed": "중앙 관리 여부", "fleet-profile": "앱 유형", "fleet-ruleset": "보호 정책 단계", "fleet-state": "관리 상태",
};
export function GitHubBootstrapControls() {
  const [pending, startTransition] = useTransition();
  const [plan, setPlan] = useState<GitHubBootstrapView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (operation: () => ReturnType<typeof readGitHubBootstrapAction>) => {
    setError(null);
    startTransition(async () => {
      const result = await operation();
      if (result.ok) setPlan(result.value);
      else setError(result.error);
    });
  };
  return <div className="space-y-3 text-sm">
    <p className="text-neutral-600">조직 공통 관리 항목 4개와 시범 앱 2개의 표시값을 중앙 기준에 맞춥니다. 코드·태그·서명 키·브랜치 보호·스토어 배포는 변경하지 않습니다.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={pending} className="rounded border px-3 py-1.5 disabled:opacity-50" onClick={() => run(() => planGitHubBootstrapAction({ requestId: crypto.randomUUID() }))}>{pending ? "확인 중…" : "변경 목록 확인"}</button>
      <button type="button" disabled={pending} className="rounded border px-3 py-1.5 disabled:opacity-50" onClick={() => run(readGitHubBootstrapAction)}>이전 실행 확인</button>
    </div>
    {plan && <>
      <p>계획된 변경 {plan.changes}건 · {plan.status === "SUCCEEDED" ? "확인 완료" : plan.status === "CANCELLED" ? "재확인 후 종료" : plan.status === "RUNNING" ? "실행 중" : plan.status === "FAILED" ? "재확인 필요" : "승인 대기"}</p>
      <p className="break-all text-xs text-neutral-500">기준 소스 {plan.plan.sourceSha.slice(0, 12)} · 실행 {plan.runId}</p>
      <ul className="space-y-1 rounded bg-neutral-50 p-3 text-xs">
        {plan.plan.operations.map((operation, index) => <li key={index}>
          {operation.kind === "SCHEMA" ? `조직 관리 항목: ${labels[String(operation.desired.property_name)]}` : operation.target.fullName}
          <div className="break-words text-neutral-500">{operation.kind === "SCHEMA"
            ? `선택값: ${(operation.desired.allowed_values as string[]).join(", ")} · 수정 권한: 조직 관리자`
            : Object.entries(operation.desired).map(([key, value]) => `${labels[key]}: ${value}`).join(" / ")}</div>
        </li>)}
      </ul>
      {plan.outcome && <p role="status" className={plan.outcome.state === "VERIFIED" ? "text-green-700" : "text-amber-800"}>
        {plan.outcome.state === "VERIFIED" ? `GitHub 조회로 ${plan.outcome.matched}건 확인 완료` : plan.outcome.state === "CLOSED_AFTER_READBACK" ? "현재 설정을 확인하고 이전 실행을 종료했습니다. 적용된 값은 되돌리지 않았습니다. 새 변경 목록을 확인할 수 있습니다." : `완료 여부 재확인 필요: ${plan.outcome.code}`} · {plan.outcome.observedAt}
      </p>}
      {!["SUCCEEDED", "CANCELLED"].includes(plan.status) && <button type="button" disabled={pending || !plan.canApply} className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-amber-900 disabled:opacity-50"
        onClick={() => run(() => applyGitHubBootstrapAction({ runId: plan.runId, planDigest: plan.planDigest, expectedGeneration: plan.generation, requestId: crypto.randomUUID() }))}>
        이번 변경만 승인하고 적용
      </button>}
      {!["SUCCEEDED", "CANCELLED"].includes(plan.status) && <button type="button" disabled={pending || !plan.canApply} className="ml-2 rounded border px-3 py-1.5 disabled:opacity-50"
        onClick={() => run(() => reconcileGitHubBootstrapAction({ runId: plan.runId, planDigest: plan.planDigest, expectedGeneration: plan.generation, requestId: crypto.randomUUID() }))}>
        결과 재확인 후 이전 실행 종료
      </button>}
      <p className="text-xs text-neutral-500">백오피스 관리자이면서 GitHub 조직 소유자인 사람만 승인할 수 있습니다. 승인은 이 변경 목록에만 1회·5분 적용됩니다. 중간에 끊기면 GitHub 상태부터 다시 확인합니다.</p>
    </>}
    {error && <p role="alert" className="break-words text-xs text-red-700">{error}</p>}
  </div>;
}
