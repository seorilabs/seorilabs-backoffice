"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  commandFleetAutomationAction,
  createFleetAutomationAction,
} from "@/lib/actions/fleet-control-plane";
import { AUTOMATION_TEMPLATE_KEY } from "@/lib/control-plane/automation-catalog";
import { managementStatusLabel } from "@/lib/control-plane/presentation";

interface DefinitionRow {
  id: string;
  key: string;
  template: string;
  schedule: string | null;
  agentKind: string | null;
  model: string | null;
  enabled: boolean;
  managed: boolean;
  maxAttempts: number;
  approvalPolicy: string;
  budgetCeilingMicros: number;
}

interface RunRow {
  id: string;
  definitionId: string;
  definitionKey: string;
  issueNumber: number | null;
  status: string;
  attempts: number;
  maxAttempts: number;
  spentMicros: number;
  workerId: string | null;
  updatedAt: string;
  error: string | null;
  outcome: unknown;
}

function auditSummary(value: unknown): string {
  if (!value || Array.isArray(value) || typeof value !== "object") return "—";
  const outcome = value as Record<string, unknown>;
  const parts = [
    typeof outcome.outcomeCode === "string" ? outcome.outcomeCode : null,
    typeof outcome.model === "string" ? outcome.model : null,
    typeof outcome.inputTokens === "number" && typeof outcome.outputTokens === "number"
      ? `${outcome.inputTokens}/${outcome.outputTokens} 토큰`
      : null,
    typeof outcome.costMicros === "number" ? `$${(outcome.costMicros / 1_000_000).toFixed(4)}` : null,
    typeof outcome.reauthRequestId === "string" ? `재로그인 ${outcome.reauthRequestId.slice(0, 8)}` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "—";
}

function cadenceLabel(schedule: string | null): string {
  if (schedule === "0 * * * *") return "매시간 UTC";
  if (schedule === "0 0 * * *") return "매일 00:00 UTC";
  return "수동";
}

export function FleetAutomationControls({
  appId,
  definitions,
  runs,
}: {
  appId: string;
  definitions: DefinitionRow[];
  runs: RunRow[];
}) {
  const [agentKind, setAgentKind] = useState("CODEX");
  const [cadence, setCadence] = useState("MANUAL");
  const [model, setModel] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState("READY_PR");
  const [budgetUsd, setBudgetUsd] = useState("1.00");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function run(action: () => Promise<{ ok: boolean; error?: string; status?: string }>, success: string) {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "요청을 처리하지 못했습니다.");
        return;
      }
      setMessage(success);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded border border-neutral-200 bg-neutral-50 p-3">
        <div className="text-sm font-semibold text-neutral-800">자동 작업 만들기</div>
        <p className="mt-1 text-xs text-neutral-500">
          자율 처리가 허용된 열린 GitHub 이슈를 한 건씩 처리합니다. 작업 보드의 표시를 바꾸는 것만으로 실행되지는 않습니다.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-neutral-600">
            작업 도구
            <select value={agentKind} onChange={(event) => setAgentKind(event.target.value)} className="mt-1 block rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm">
              <option value="CODEX">Codex</option>
              <option value="CLAUDE">Claude</option>
            </select>
          </label>
          <label className="text-xs text-neutral-600">
            실행
            <select value={cadence} onChange={(event) => setCadence(event.target.value)} className="mt-1 block rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm">
              <option value="MANUAL">지금 한 번 실행</option>
              <option value="HOURLY">매시간</option>
              <option value="DAILY">매일</option>
            </select>
          </label>
          <label className="text-xs text-neutral-600">
            승인 범위
            <select value={approvalPolicy} onChange={(event) => setApprovalPolicy(event.target.value)} className="mt-1 block rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm">
              <option value="READY_PR">변경 검토 요청까지</option>
              <option value="READ_ONLY">읽기 전용</option>
            </select>
          </label>
          <label className="text-xs text-neutral-600">
            1회 예산 상한 USD
            <input type="number" min="0.01" max="1000" step="0.01" value={budgetUsd} onChange={(event) => setBudgetUsd(event.target.value)} className="mt-1 block w-28 rounded border border-neutral-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs text-neutral-600">
            사용할 모델 — 검증된 모델만
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="비용이 가장 낮은 기본 모델" className="mt-1 block rounded border border-neutral-300 px-2 py-1.5 text-sm" />
          </label>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(
              () => createFleetAutomationAction({
                appId,
                template: AUTOMATION_TEMPLATE_KEY,
                agentKind,
                cadence,
                approvalPolicy,
                budgetCeilingMicros: Math.round(Number(budgetUsd) * 1_000_000),
                model: model || undefined,
                maxAttempts: 3,
                requestId: crypto.randomUUID(),
              }),
              cadence === "MANUAL"
                ? "자동 작업을 만들고 즉시 실행을 요청했습니다. 실제 시작 여부는 실행 이력에서 확인하세요."
                : "정기 자동 작업을 만들었습니다.",
            )}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {pending ? "처리 중…" : "자동 작업 만들기"}
          </button>
        </div>
        {message && <p role="status" className="mt-2 text-sm text-emerald-700">{message}</p>}
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {definitions.map((definition) => (
          <div key={definition.id} className="rounded border border-neutral-200 px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{definition.agentKind ?? "미지정"} · {cadenceLabel(definition.schedule)}</span>
              <span className={definition.enabled ? "text-emerald-700" : "text-neutral-400"}>
                {!definition.managed ? "중앙 관리 미적용" : definition.enabled ? "사용 중" : "일시중지"}
              </span>
            </div>
            <div className="mt-1 truncate text-xs text-neutral-500">
              {definition.template === AUTOMATION_TEMPLATE_KEY ? "이슈 자동 처리" : definition.template} · {definition.model ?? "비용이 낮은 기본 모델"}
            </div>
            <div className="mt-1 text-xs text-neutral-500">
              {managementStatusLabel(definition.approvalPolicy)} · 1회 ${(definition.budgetCeilingMicros / 1_000_000).toFixed(2)}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button type="button" disabled={pending || !definition.enabled || !definition.managed} onClick={() => run(
                () => commandFleetAutomationAction({ appId, definitionId: definition.id, command: "RUN_NOW", requestId: crypto.randomUUID() }),
                "즉시 실행을 요청했습니다.",
              )} className="rounded border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40">지금 실행</button>
              <button type="button" disabled={pending || !definition.managed} onClick={() => run(
                () => commandFleetAutomationAction({
                  appId,
                  definitionId: definition.id,
                  command: definition.enabled ? "PAUSE" : "RESUME",
                  requestId: crypto.randomUUID(),
                }),
                definition.enabled ? "자동 작업을 일시중지했습니다." : "자동 작업을 재개했습니다.",
              )} className="rounded border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40">{definition.enabled ? "일시중지" : "재개"}</button>
            </div>
          </div>
        ))}
        {definitions.length === 0 && <div className="py-5 text-center text-sm text-neutral-400">등록된 자동 작업이 없습니다.</div>}
      </div>

      <div className="overflow-x-auto rounded border border-neutral-200">
        <table className="w-full min-w-[860px] text-left text-xs">
          <thead className="border-b border-neutral-200 bg-neutral-50 text-neutral-500">
            <tr><th className="px-3 py-2">자동 작업</th><th>대상</th><th>상태</th><th>시도</th><th>실행 도구</th><th>실행 내역</th><th>갱신</th><th>제어</th></tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {runs.map((runRow) => (
              <tr key={runRow.id}>
                <td className="px-3 py-2 font-medium">{runRow.definitionKey}</td>
                <td>{runRow.issueNumber ? `#${runRow.issueNumber}` : runRow.id.slice(0, 10)}</td>
                <td title={runRow.status}>{managementStatusLabel(runRow.status)}</td>
                <td>{runRow.attempts}/{runRow.maxAttempts} · ${(runRow.spentMicros / 1_000_000).toFixed(4)}</td>
                <td>{runRow.workerId ?? "—"}</td>
                <td className="max-w-64 truncate" title={auditSummary(runRow.outcome)}>{auditSummary(runRow.outcome)}</td>
                <td>{runRow.updatedAt}</td>
                <td>
                  {(["PENDING", "RUNNING"].includes(runRow.status)) && (
                    <button type="button" disabled={pending} onClick={() => run(
                      () => commandFleetAutomationAction({ appId, definitionId: runRow.definitionId, command: "CANCEL_RUN", runId: runRow.id, requestId: crypto.randomUUID() }),
                      "작업을 중단했습니다. 외부에서 이미 실행됐을 가능성이 있으면 결과 확인 대기로 전환됩니다.",
                    )} className="rounded border border-red-200 px-2 py-1 text-red-700 disabled:opacity-40">취소</button>
                  )}
                  {runRow.status === "DEAD_LETTER" && (
                    <button type="button" disabled={pending} onClick={() => run(
                      () => commandFleetAutomationAction({ appId, definitionId: runRow.definitionId, command: "RETRY_RUN", runId: runRow.id, requestId: crypto.randomUUID() }),
                      "같은 작업을 다시 시도하도록 요청했습니다.",
                    )} className="rounded border border-amber-300 px-2 py-1 text-amber-800 disabled:opacity-40">재시도</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs.length === 0 && <div className="py-5 text-center text-sm text-neutral-400">실행 이력이 없습니다.</div>}
      </div>
    </div>
  );
}
