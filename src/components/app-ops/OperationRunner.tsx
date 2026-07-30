"use client";

import { useEffect, useState, useTransition } from "react";

import {
  dispatchAppOperationAction,
  getAppOperationStatusAction,
  listAppOperationRunsAction,
} from "@/lib/actions/app-ops";
import { typedConfirmationText } from "@/lib/app-ops/execution";
import type { AppOpsOperation } from "@/lib/app-ops/manifest";
import type { AppOpsRunSummary } from "@/lib/github/app-ops";

const POLL_INTERVAL_MS = 2_000;
const POLL_LIMIT = 45;

export function OperationRunner({
  appId,
  toolId,
  operation,
}: {
  appId: string;
  toolId: string;
  operation: AppOpsOperation;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [runUrl, setRunUrl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirmation = typedConfirmationText(toolId, operation.id);

  function submit() {
    setMessage(null);
    setResult(null);
    startTransition(async () => {
      const response = await dispatchAppOperationAction(
        appId,
        toolId,
        operation.id,
        values,
        reason,
        typed,
      );
      if (!response.ok || !response.requestId) {
        setMessage(response.error ?? "오퍼레이션을 시작하지 못했습니다.");
        return;
      }
      setRequestId(response.requestId);
      setRunUrl(response.actionsUrl ?? null);
      setMessage("GitHub Actions 실행을 기다리는 중입니다.");
      void poll(response.requestId);
    });
  }

  async function poll(id: string) {
    for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
      const response = await getAppOperationStatusAction(appId, id);
      if (!response.ok) {
        setMessage(response.error ?? "실행 상태를 읽지 못했습니다.");
        return;
      }
      if (response.url) setRunUrl(response.url);
      if (!response.found) {
        setMessage("GitHub Actions 실행 생성 대기 중입니다.");
      } else if (response.status !== "completed") {
        setMessage(`실행 상태: ${response.status ?? "unknown"}`);
      } else {
        if (response.result) {
          setResult(response.result);
          setMessage(
            response.result.status === "success"
              ? response.result.summary
              : `실행 실패: ${response.result.summary}`,
          );
        } else {
          setMessage(
            response.resultError ??
              `실행 완료: ${response.conclusion ?? "결과 artifact 없음"}`,
          );
        }
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
    }
    setMessage("자동 확인 시간이 끝났습니다. 실행 이력에서 결과를 다시 불러오세요.");
  }

  return (
    <div className="mt-3 rounded border border-neutral-200 bg-neutral-50 p-3">
      <div className="grid gap-3 md:grid-cols-2">
        {operation.inputs.map((input) => (
          <label key={input.key} className="text-xs text-neutral-600">
            <span className="mb-1 block font-medium">
              {input.label}
              {input.required ? " *" : ""}
            </span>
            {input.type === "select" ? (
              <select
                className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
                value={String(values[input.key] ?? "")}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [input.key]: event.target.value }))
                }
              >
                <option value="">선택</option>
                {input.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : input.type === "boolean" ? (
              <input
                type="checkbox"
                checked={Boolean(values[input.key])}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [input.key]: event.target.checked }))
                }
              />
            ) : input.type === "textarea" ? (
              <textarea
                className="min-h-20 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
                placeholder={input.placeholder}
                value={String(values[input.key] ?? "")}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [input.key]: event.target.value }))
                }
              />
            ) : (
              <input
                type={input.type === "number" ? "number" : "text"}
                className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
                placeholder={input.placeholder}
                value={String(values[input.key] ?? "")}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [input.key]: event.target.value }))
                }
              />
            )}
            {input.help && <span className="mt-1 block text-[11px] text-neutral-400">{input.help}</span>}
          </label>
        ))}
      </div>

      {operation.intent === "mutate" && (
        <label className="mt-3 block text-xs text-neutral-600">
          <span className="mb-1 block font-medium">변경 사유 *</span>
          <textarea
            className="min-h-16 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      )}
      {operation.confirmation === "typed" && (
        <label className="mt-3 block text-xs text-red-700">
          <span className="mb-1 block font-medium">
            실행하려면 <code>{confirmation}</code> 입력
          </span>
          <input
            className="w-full rounded border border-red-200 bg-white px-2 py-1.5 font-mono text-sm"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={submit}
          className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? "요청 중…" : operation.intent === "read" ? "조회 실행" : "변경 실행"}
        </button>
        {requestId && <span className="font-mono text-[10px] text-neutral-400">{requestId}</span>}
        {runUrl && (
          <a
            href={runUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-600 hover:underline"
          >
            Actions 열기 ↗
          </a>
        )}
      </div>
      {message && <div className="mt-2 text-xs text-neutral-600">{message}</div>}
      {result !== null && (
        <pre className="mt-2 max-h-80 overflow-auto rounded bg-neutral-950 p-3 text-[11px] text-neutral-100">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function OperationHistory({ appId }: { appId: string }) {
  const [runs, setRuns] = useState<AppOpsRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedResult, setSelectedResult] = useState<unknown>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const response = await listAppOperationRunsAction(appId);
      if (!response.ok) setError(response.error ?? "실행 이력을 읽지 못했습니다.");
      else setRuns(response.runs ?? []);
    });
  }, [appId]);

  function loadResult(requestId: string) {
    setError(null);
    startTransition(async () => {
      const response = await getAppOperationStatusAction(appId, requestId);
      if (!response.ok) {
        setError(response.error ?? "실행 결과를 읽지 못했습니다.");
        return;
      }
      setSelectedResult(response.result ?? { status: response.status, error: response.resultError });
    });
  }

  if (!pending && runs.length === 0 && !error) return null;
  return (
    <div className="mt-5 rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-sm font-semibold text-neutral-700">최근 실행</div>
      {pending && runs.length === 0 && <div className="mt-2 text-xs text-neutral-400">불러오는 중…</div>}
      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
      <div className="mt-2 divide-y divide-neutral-100">
        {runs.map((run) => (
          <div key={run.requestId} className="flex flex-wrap items-center gap-2 py-2 text-xs">
            <span className="font-medium text-neutral-700">{run.operation}</span>
            <span className="text-neutral-400">
              {run.status}
              {run.conclusion ? ` / ${run.conclusion}` : ""}
            </span>
            <span className="text-neutral-400">
              {new Date(run.createdAt).toLocaleString("ko-KR")}
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => loadResult(run.requestId)}
              className="text-blue-600 hover:underline disabled:opacity-50"
            >
              결과 보기
            </button>
            <a href={run.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
              Actions ↗
            </a>
          </div>
        ))}
      </div>
      {selectedResult !== null && (
        <pre className="mt-3 max-h-80 overflow-auto rounded bg-neutral-950 p-3 text-[11px] text-neutral-100">
          {JSON.stringify(selectedResult, null, 2)}
        </pre>
      )}
    </div>
  );
}
