"use client";

import { useEffect, useState, useTransition } from "react";

import { dispatchBuildAction } from "@/lib/actions/builds";
import { listAppTagsAction } from "@/lib/actions/release";
import {
  BUILD_TARGET_DEFINITIONS,
  type BuildTarget,
} from "@/lib/core/build-targets";

export function BuildControls({
  appId,
  targets,
  discoveryError,
}: {
  appId: string;
  targets: BuildTarget[];
  discoveryError?: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState("");
  const [target, setTarget] = useState<BuildTarget | "">(targets[0] ?? "");
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    message: string;
    workflowUrl?: string;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    listAppTagsAction(appId)
      .then(({ tags: nextTags }) => {
        if (!alive) return;
        setTags(nextTags);
        setTag(nextTags[0] ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [appId]);

  function build() {
    if (!tag || !target) return;
    const definition = BUILD_TARGET_DEFINITIONS[target];
    if (
      !window.confirm(
        `${tag}의 ${definition.artifact} 산출물을 빌드할까요? 마켓 업로드는 실행하지 않습니다.`,
      )
    ) {
      return;
    }
    setFeedback(null);
    startTransition(async () => {
      const result = await dispatchBuildAction(appId, tag, target);
      setFeedback(
        result.ok
          ? {
              ok: true,
              message: `${definition.label} 요청됨 · 마켓 업로드 없음`,
              workflowUrl: result.workflowUrl,
            }
          : { ok: false, message: result.error ?? "빌드 요청에 실패했습니다." },
      );
    });
  }

  const selectClass = "rounded border border-neutral-300 px-2 py-1 text-sm";
  const buttonClass =
    "rounded border border-neutral-300 px-2.5 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50";

  if (discoveryError) {
    return <p className="text-sm text-red-700">{discoveryError}</p>;
  }

  if (targets.length === 0) {
    return (
      <p className="text-sm text-neutral-400">
        기본 브랜치에 등록된 build-only workflow가 없습니다.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {tags.length === 0 ? (
          <span className="text-xs text-neutral-400">릴리스 태그 없음 — 먼저 생성하세요</span>
        ) : (
          <>
            <select
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              disabled={pending}
              className={selectClass}
              aria-label="빌드할 릴리스 태그"
            >
              {tags.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value as BuildTarget)}
              disabled={pending}
              className={selectClass}
              aria-label="빌드 대상"
            >
              {targets.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {BUILD_TARGET_DEFINITIONS[candidate].label}
                </option>
              ))}
            </select>
            <button onClick={build} disabled={pending} className={buttonClass}>
              🧱 빌드
            </button>
          </>
        )}
        {feedback && (
          <span className={feedback.ok ? "text-xs text-emerald-700" : "text-xs text-red-700"}>
            {feedback.message}
            {feedback.workflowUrl && (
              <>
                {" · "}
                <a
                  href={feedback.workflowUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Actions에서 확인
                </a>
              </>
            )}
          </span>
        )}
      </div>
      <p className="text-[11px] text-neutral-400">
        태그 기준 후보 artifact만 생성합니다. AppsInToss·Google Play 업로드와 출시 상태 전이는
        실행하지 않습니다.
      </p>
    </div>
  );
}
