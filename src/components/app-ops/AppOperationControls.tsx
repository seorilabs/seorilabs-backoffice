"use client";

import { useEffect, useState, useTransition } from "react";

import {
  dispatchAppOperationAction,
  getAppOperationStatusAction,
  listAppOperationRunsAction,
} from "@/lib/actions/app-ops";
import type { AppOpsOperation } from "@/lib/app-ops/manifest";
import type { AppOpsResult } from "@/lib/app-ops/operation";
import type { AppOpsRunSummary } from "@/lib/app-ops/runs";

const POLL_INTERVAL_MS = 1_000;
const POLL_LIMIT = 60;

export function AppOperationControls({
  appId,
  toolId,
  operation,
}: {
  appId: string;
  toolId: string;
  operation: AppOpsOperation;
}) {
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      operation.inputs.map((input) => [
        input.key,
        input.type === "boolean" ? false : "",
      ]),
    ),
  );
  const [reason, setReason] = useState("");
  const [confirmationText, setConfirmationText] = useState("");
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [operationResult, setOperationResult] = useState<AppOpsResult | null>(
    null,
  );

  function updateValue(key: string, value: string | boolean) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    setOperationResult(null);
    startTransition(async () => {
      const response = await dispatchAppOperationAction({
        appId,
        toolId,
        operationId: operation.id,
        values,
        reason,
        confirmationText,
      });
      if (!response.ok || !response.requestId) {
        setFeedback({
          ok: false,
          message: response.error ?? "실행 요청에 실패했습니다.",
        });
        return;
      }
      setFeedback({
        ok: true,
        message: `실행 요청됨 · ${response.requestId.slice(0, 8)}`,
      });
      setReason("");
      setConfirmationText("");
      void poll(response.requestId);
    });
  }

  async function poll(requestId: string) {
    for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
      const response = await getAppOperationStatusAction(appId, requestId);
      if (!response.ok) {
        setFeedback({
          ok: false,
          message: response.error ?? "실행 상태를 읽지 못했습니다.",
        });
        return;
      }
      if (!response.found) {
        setFeedback({ ok: true, message: "Kubernetes worker 요청 생성 대기 중입니다." });
      } else if (response.status !== "completed") {
        setFeedback({
          ok: true,
          message: `실행 상태 · ${response.status ?? "unknown"}`,
        });
      } else if (response.result) {
        setOperationResult(response.result);
        setFeedback({
          ok: response.result.status === "success",
          message: response.result.summary,
        });
        return;
      } else {
        setFeedback({
          ok: false,
          message:
            response.resultError ??
            `실행 완료 · ${response.conclusion ?? "결과 artifact 없음"}`,
        });
        return;
      }
      await new Promise((resolve) =>
        window.setTimeout(resolve, POLL_INTERVAL_MS),
      );
    }
    setFeedback({
      ok: false,
      message: "자동 확인 시간이 끝났습니다. 최근 실행에서 결과를 다시 확인하세요.",
    });
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded bg-neutral-50 p-3">
      {operation.inputs.map((input) => (
        <label key={input.key} className="block text-xs text-neutral-600">
          <span className="mb-1 block font-medium">
            {input.label}
            {input.required && <span className="ml-0.5 text-red-500">*</span>}
          </span>
          {input.type === "select" ? (
            <select
              value={String(values[input.key] ?? "")}
              onChange={(event) => updateValue(input.key, event.target.value)}
              required={input.required}
              disabled={pending}
              className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">선택</option>
              {input.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : input.type === "textarea" ? (
            <textarea
              value={String(values[input.key] ?? "")}
              onChange={(event) => updateValue(input.key, event.target.value)}
              required={input.required}
              disabled={pending}
              placeholder={input.placeholder}
              className="min-h-20 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
            />
          ) : input.type === "boolean" ? (
            <input
              type="checkbox"
              checked={Boolean(values[input.key])}
              onChange={(event) => updateValue(input.key, event.target.checked)}
              disabled={pending}
              className="h-4 w-4 rounded border-neutral-300"
            />
          ) : (
            <input
              type={input.type === "number" ? "number" : "text"}
              value={String(values[input.key] ?? "")}
              onChange={(event) => updateValue(input.key, event.target.value)}
              required={input.required}
              disabled={pending}
              placeholder={input.placeholder}
              className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
            />
          )}
          {input.help && (
            <span className="mt-1 block text-[11px] text-neutral-400">
              {input.help}
            </span>
          )}
        </label>
      ))}

      {operation.intent === "mutate" && (
        <label className="block text-xs text-neutral-600">
          <span className="mb-1 block font-medium">변경 사유*</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            maxLength={500}
            disabled={pending}
            className="min-h-16 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
          />
        </label>
      )}

      {operation.confirmation === "typed" && (
        <label className="block text-xs text-neutral-600">
          <span className="mb-1 block font-medium">
            확인 문구 “{operation.label}” 입력*
          </span>
          <input
            value={confirmationText}
            onChange={(event) => setConfirmationText(event.target.value)}
            required
            disabled={pending}
            className="w-full rounded border border-red-200 bg-white px-2 py-1.5 text-sm"
          />
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {pending
            ? "요청 중…"
            : operation.intent === "read"
              ? "조회 실행"
              : "변경 실행"}
        </button>
        {feedback && (
          <span
            className={`text-xs ${feedback.ok ? "text-emerald-700" : "text-red-600"}`}
          >
            {feedback.message}
          </span>
        )}
      </div>
      {operationResult && (
        <pre className="max-h-80 overflow-auto rounded bg-neutral-950 p-3 text-[11px] text-neutral-100">
          {JSON.stringify(operationResult, null, 2)}
        </pre>
      )}
    </form>
  );
}

export function AppOperationHistory({ appId }: { appId: string }) {
  const [runs, setRuns] = useState<AppOpsRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedResult, setSelectedResult] = useState<unknown>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const response = await listAppOperationRunsAction(appId);
      if (!response.ok) {
        setError(response.error ?? "실행 이력을 읽지 못했습니다.");
      } else {
        setRuns(response.runs ?? []);
      }
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
      setSelectedResult(
        response.result ?? {
          status: response.status,
          conclusion: response.conclusion,
          error: response.resultError,
        },
      );
    });
  }

  if (!pending && runs.length === 0 && !error) return null;
  return (
    <div className="mt-5 rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-sm font-semibold text-neutral-700">최근 실행</div>
      {pending && runs.length === 0 && (
        <div className="mt-2 text-xs text-neutral-400">불러오는 중…</div>
      )}
      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
      <div className="mt-2 divide-y divide-neutral-100">
        {runs.map((run) => (
          <div
            key={run.requestId}
            className="flex flex-wrap items-center gap-2 py-2 text-xs"
          >
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
