"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPlanningIssue } from "@/lib/actions/issues";
import { env } from "@/lib/env";

interface AppOption {
  repoFullName: string;
  displayName: string;
}

export function PlanForm({ apps }: { apps: AppOption[] }) {
  const [form, setForm] = useState({
    repoFullName: apps[0]?.repoFullName ?? "",
    title: "",
    summary: "",
    market: "",
    priority: "",
    owner: "",
    agent: "",
    intakeState: "",
    target: "",
    verification: "",
    labels: "",
  });
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ number: number; htmlUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    setError(null);
    setResult(null);
    if (!form.repoFullName || !form.title.trim()) {
      setError("레포와 제목은 필수입니다.");
      return;
    }
    startTransition(async () => {
      try {
        const labels = form.labels
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (form.priority) labels.push(form.priority);
        const r = await createPlanningIssue({
          repoFullName: form.repoFullName,
          title: form.title,
          summary: form.summary,
          market: form.market || undefined,
          priority: form.priority || undefined,
          owner: form.owner || undefined,
          agent: form.agent || undefined,
          intakeState: form.intakeState || undefined,
          target: form.target || undefined,
          verification: form.verification || undefined,
          labels,
        });
        setResult(r);
        set("title", "");
        set("summary", "");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "이슈 생성 실패");
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-3">
      <Field label="레포 *">
        <select
          value={form.repoFullName}
          onChange={(e) => set("repoFullName", e.target.value)}
          className="input"
        >
          {apps.map((a) => (
            <option key={a.repoFullName} value={a.repoFullName}>
              {a.displayName} ({a.repoFullName})
            </option>
          ))}
        </select>
      </Field>
      <Field label="제목 *">
        <input className="input" value={form.title} onChange={(e) => set("title", e.target.value)} />
      </Field>
      <Field label="기획 내용 (본문)">
        <textarea
          className="input min-h-28"
          value={form.summary}
          onChange={(e) => set("summary", e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Market">
          <input className="input" value={form.market} onChange={(e) => set("market", e.target.value)} />
        </Field>
        <Field label="Priority">
          <select className="input" value={form.priority} onChange={(e) => set("priority", e.target.value)}>
            <option value="">—</option>
            {["P1", "P2", "P3", "P4"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Owner">
          <input className="input" value={form.owner} onChange={(e) => set("owner", e.target.value)} />
        </Field>
        <Field label="Agent">
          <input className="input" value={form.agent} onChange={(e) => set("agent", e.target.value)} />
        </Field>
        <Field label="Intake State">
          <input className="input" value={form.intakeState} onChange={(e) => set("intakeState", e.target.value)} />
        </Field>
        <Field label="Target">
          <input className="input" value={form.target} onChange={(e) => set("target", e.target.value)} />
        </Field>
      </div>
      <Field label="Verification">
        <input className="input" value={form.verification} onChange={(e) => set("verification", e.target.value)} />
      </Field>
      <Field label="추가 라벨 (콤마구분)">
        <input
          className="input"
          placeholder="feature, retention"
          value={form.labels}
          onChange={(e) => set("labels", e.target.value)}
        />
      </Field>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          disabled={pending}
          onClick={submit}
          className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {pending ? "생성중…" : "GitHub 이슈 생성"}
        </button>
        {env.featureMinimax() ? null : (
          <button
            type="button"
            disabled
            title="v2 예정"
            className="cursor-not-allowed rounded border border-neutral-300 px-4 py-2 text-sm text-neutral-400"
          >
            AI 초안 생성 (v2)
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {result && (
        <p className="text-sm text-emerald-700">
          생성됨:{" "}
          <a className="underline" href={result.htmlUrl} target="_blank" rel="noreferrer">
            #{result.number}
          </a>
        </p>
      )}

      <style>{`.input{width:100%;border:1px solid #d4d4d4;border-radius:0.375rem;padding:0.45rem 0.6rem;font-size:0.875rem;background:white}`}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}
