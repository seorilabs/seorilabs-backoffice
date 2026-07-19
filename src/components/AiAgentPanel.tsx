"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  generateStageDraft,
  commitDraft,
  discardDraft,
  type DraftView,
} from "@/lib/actions/ai";

const KIND_META: Record<
  string,
  { ko: string; needsTitle: boolean; commitLabel: string }
> = {
  TASK_BREAKDOWN: { ko: "분해 에이전트", needsTitle: false, commitLabel: "코멘트로 커밋" },
  QA_CHECKLIST: { ko: "QA 에이전트", needsTitle: false, commitLabel: "코멘트로 커밋" },
  STORE_COPY: { ko: "스토어 에이전트", needsTitle: true, commitLabel: "이슈로 커밋" },
  IMPROVEMENT_HYPOTHESIS: { ko: "개선 에이전트", needsTitle: true, commitLabel: "이슈로 커밋" },
  RELEASE_NOTES: { ko: "릴리스노트 에이전트", needsTitle: true, commitLabel: "이슈로 커밋" },
};

// 대상 이슈가 필요한 에이전트(코멘트형).
const NEEDS_ISSUE = new Set(["TASK_BREAKDOWN", "QA_CHECKLIST"]);

type GenKind =
  | "TASK_BREAKDOWN"
  | "QA_CHECKLIST"
  | "STORE_COPY"
  | "IMPROVEMENT_HYPOTHESIS"
  | "RELEASE_NOTES";

interface IssueOpt {
  number: number;
  title: string;
}

export function AiAgentPanel({
  appId,
  aiEnabled,
  openIssues,
  initialDrafts,
}: {
  appId: string;
  aiEnabled: boolean;
  openIssues: IssueOpt[];
  initialDrafts: DraftView[];
}) {
  const [drafts, setDrafts] = useState<DraftView[]>(initialDrafts);
  const [issueNumber, setIssueNumber] = useState<number | "">(
    openIssues[0]?.number ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [genKind, setGenKind] = useState<string | null>(null);
  const [, startGen] = useTransition();

  if (!aiEnabled) {
    return (
      <p className="text-sm text-neutral-400">
        AI 에이전트 비활성 (FEATURE_GEMINI_ENABLED + GEMINI_API_KEY 필요).
      </p>
    );
  }

  function gen(kind: GenKind) {
    setError(null);
    if (NEEDS_ISSUE.has(kind) && !issueNumber) {
      setError("대상 열린 이슈를 선택하세요.");
      return;
    }
    setGenKind(kind);
    startGen(async () => {
      try {
        const d = await generateStageDraft({
          appId,
          kind,
          issueNumber: NEEDS_ISSUE.has(kind) ? Number(issueNumber) : undefined,
        });
        setDrafts((prev) => [d, ...prev]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "생성 실패");
      } finally {
        setGenKind(null);
      }
    });
  }

  function removeDraft(id: string) {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-end gap-3">
          <div>
            <div className="mb-1 text-xs font-medium text-neutral-500">대상 이슈 (분해·QA)</div>
            <select
              className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
              value={issueNumber}
              onChange={(e) =>
                setIssueNumber(e.target.value ? Number(e.target.value) : "")
              }
              disabled={openIssues.length === 0}
            >
              {openIssues.length === 0 && <option value="">열린 이슈 없음</option>}
              {openIssues.map((i) => (
                <option key={i.number} value={i.number}>
                  #{i.number} {i.title.slice(0, 40)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <AgentButton genKind={genKind} kind="TASK_BREAKDOWN" label="🧩 작업 분해" busy="분해중…" onClick={gen} disabled={openIssues.length === 0} />
          <AgentButton genKind={genKind} kind="QA_CHECKLIST" label="🧪 QA 체크리스트" busy="작성중…" onClick={gen} disabled={openIssues.length === 0} />
          <AgentButton genKind={genKind} kind="RELEASE_NOTES" label="📝 릴리스 노트" busy="작성중…" onClick={gen} />
          <AgentButton genKind={genKind} kind="STORE_COPY" label="🏬 스토어 문안" busy="작성중…" onClick={gen} />
          <AgentButton genKind={genKind} kind="IMPROVEMENT_HYPOTHESIS" label="💡 개선 가설" busy="분석중…" onClick={gen} />
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {drafts.length === 0 && (
        <p className="text-sm text-neutral-400">
          위 버튼으로 초안을 생성하세요. 초안은 검토·수정 후 1클릭으로 GitHub 에 커밋됩니다.
        </p>
      )}

      {drafts.map((d) => (
        <DraftCard key={d.id} draft={d} onDone={() => removeDraft(d.id)} />
      ))}
    </div>
  );
}

function AgentButton({
  genKind,
  kind,
  label,
  busy,
  onClick,
  disabled,
}: {
  genKind: string | null;
  kind: GenKind;
  label: string;
  busy: string;
  onClick: (k: GenKind) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={genKind !== null || disabled}
      onClick={() => onClick(kind)}
      className="rounded border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
    >
      {genKind === kind ? busy : label}
    </button>
  );
}

function DraftCard({
  draft,
  onDone,
}: {
  draft: DraftView;
  onDone: () => void;
}) {
  const meta = KIND_META[draft.kind] ?? {
    ko: draft.kind,
    needsTitle: false,
    commitLabel: "커밋",
  };
  const [text, setText] = useState(draft.outputText);
  const [title, setTitle] = useState(draft.title ?? "");
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function doCommit() {
    setError(null);
    startTransition(async () => {
      try {
        const r = await commitDraft({
          draftId: draft.id,
          editedText: text,
          editedTitle: meta.needsTitle ? title : undefined,
        });
        setCommitted(r.url);
        router.refresh();
        setTimeout(onDone, 1500);
      } catch (e) {
        setError(e instanceof Error ? e.message : "커밋 실패");
      }
    });
  }

  function doDiscard() {
    startTransition(async () => {
      try {
        await discardDraft(draft.id);
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : "폐기 실패");
      }
    });
  }

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="rounded bg-violet-100 px-2 py-0.5 font-medium text-violet-700">
          {meta.ko}
        </span>
        <span className="text-neutral-400">{draft.model}</span>
        {draft.issueNumber && (
          <span className="text-neutral-500">대상 #{draft.issueNumber}</span>
        )}
      </div>

      {meta.needsTitle && (
        <input
          className="mb-2 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="이슈 제목"
        />
      )}
      <textarea
        className="min-h-48 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 font-mono text-xs leading-relaxed"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {committed ? (
        <p className="mt-2 text-sm text-emerald-700">
          커밋됨:{" "}
          <a className="underline" href={committed} target="_blank" rel="noreferrer">
            GitHub 에서 열기
          </a>
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={doCommit}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {pending ? "처리중…" : `GitHub 에 ${meta.commitLabel}`}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={doDiscard}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
          >
            폐기
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
