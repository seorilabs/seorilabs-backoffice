"use client";

import { useState, useTransition } from "react";

import { dispatchAppOperationAction } from "@/lib/actions/app-ops";
import type { AppOpsOperation } from "@/lib/app-ops/manifest";

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
      operation.inputs.map((input) => [input.key, input.type === "boolean" ? false : ""]),
    ),
  );
  const [reason, setReason] = useState("");
  const [confirmationText, setConfirmationText] = useState("");
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    workflowUrl?: string;
  } | null>(null);

  function updateValue(key: string, value: string | boolean) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(null);
    startTransition(async () => {
      const response = await dispatchAppOperationAction({
        appId,
        toolId,
        operationId: operation.id,
        values,
        reason,
        confirmationText,
      });
      setResult(
        response.ok
          ? {
              ok: true,
              message: `실행 요청됨 · ${response.requestId?.slice(0, 8)}`,
              workflowUrl: response.workflowUrl,
            }
          : { ok: false, message: response.error ?? "실행 요청에 실패했습니다." },
      );
      if (response.ok) {
        setReason("");
        setConfirmationText("");
      }
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
          {input.help && <span className="mt-1 block text-[11px] text-neutral-400">{input.help}</span>}
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
        {result && (
          <span className={`text-xs ${result.ok ? "text-emerald-700" : "text-red-600"}`}>
            {result.message}
            {result.workflowUrl && (
              <>
                {" · "}
                <a
                  href={result.workflowUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Actions 확인
                </a>
              </>
            )}
          </span>
        )}
      </div>
    </form>
  );
}
