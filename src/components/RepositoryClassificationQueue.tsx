"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { decideRepositoryClassificationAction } from "@/lib/actions/repository-classification";
import type { RepositoryClassificationQueueItem } from "@/lib/control-plane/repository-classification-decision";

type Classification = "PRODUCT_APP" | "INFRA_REPO" | "PLATFORM_PRODUCER" | "EXCLUDED";

function QueueItem({ item }: { item: RepositoryClassificationQueueItem }) {
  const options: Classification[] = item.fork
    ? ["EXCLUDED"]
    : ["PRODUCT_APP", "INFRA_REPO", "PLATFORM_PRODUCER", "EXCLUDED"];
  const [classification, setClassification] = useState<Classification>(options[0]);
  const [candidateMarkerPath, setCandidateMarkerPath] = useState(item.candidates.length > 1
    ? item.candidates[0].markerPath
    : "");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function decide() {
    setMessage(null);
    startTransition(async () => {
      const selectedMarker = classification === "PRODUCT_APP" && candidateMarkerPath
        ? candidateMarkerPath
        : null;
      const result = await decideRepositoryClassificationAction({
        repoId: item.repoId,
        expectedGeneration: item.generation,
        expectedDecisionRevision: item.decisionRevision,
        classification,
        candidateMarkerPath: selectedMarker,
        justification: classification === "PRODUCT_APP" && selectedMarker
          ? "APP_CANDIDATE_SELECTED"
          : "REPOSITORY_PURPOSE_CONFIRMED",
        requestId: crypto.randomUUID(),
      });
      if (!result.ok) {
        setMessage(result.error ?? "분류 저장 실패");
        return;
      }
      setMessage(`분류 revision ${result.revision} 저장 · discovery 재검증 대기`);
      router.refresh();
    });
  }

  return (
    <div className="rounded border border-neutral-200 p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{item.repoFullName}</span>
        <span className="font-mono text-xs text-neutral-500">repo {item.repoId} · gen {item.generation}</span>
      </div>
      <p className="mt-1 text-xs text-amber-700">
        {item.reasonCode ?? "분류 입력 필요"}{item.fork ? " · fork" : ""}
      </p>
      {item.candidates.length > 0 && (
        <p className="mt-1 break-all text-xs text-neutral-500">
          후보: {item.candidates.map((candidate) => candidate.markerPath).join(", ")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <select
          aria-label={`${item.repoFullName} 분류`}
          value={classification}
          disabled={pending}
          onChange={(event) => setClassification(event.target.value as Classification)}
          className="rounded border border-neutral-300 bg-white px-2 py-1.5"
        >
          {options.map((option) => <option key={option}>{option}</option>)}
        </select>
        {classification === "PRODUCT_APP" && item.candidates.length > 1 && (
          <select
            aria-label={`${item.repoFullName} 앱 후보`}
            value={candidateMarkerPath}
            disabled={pending}
            onChange={(event) => setCandidateMarkerPath(event.target.value)}
            className="max-w-full rounded border border-neutral-300 bg-white px-2 py-1.5 font-mono text-xs"
          >
            {item.candidates.map((candidate) => (
              <option key={candidate.markerPath} value={candidate.markerPath}>{candidate.markerPath}</option>
            ))}
          </select>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={decide}
          className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-50"
        >
          {pending ? "저장 중…" : "분류 후 재검증"}
        </button>
      </div>
      {message && <p className="mt-2 text-xs text-neutral-700">{message}</p>}
    </div>
  );
}

export function RepositoryClassificationQueue({
  items,
}: {
  items: RepositoryClassificationQueueItem[];
}) {
  if (items.length === 0) {
    return <p className="text-sm text-neutral-500">현재 분류 판단이 필요한 repository가 없습니다.</p>;
  }
  return <div className="space-y-3">{items.map((item) => <QueueItem key={item.repoId} item={item} />)}</div>;
}
