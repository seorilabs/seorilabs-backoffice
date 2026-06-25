"use client";

import { useState } from "react";

export interface ReleaseNoteCardProps {
  appName: string;
  appId: string;
  version: string;
  previousVersion: string | null;
  createdAt: string;
  compareUrl: string | null;
  koKR: string;
  enUS: string;
}

export function ReleaseNoteCard(props: ReleaseNoteCardProps) {
  const [lang, setLang] = useState<"ko" | "en">("ko");
  const body = lang === "ko" ? props.koKR : props.enUS;
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{props.appName}</span>
        <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs font-medium text-white">
          {props.version}
        </span>
        {props.previousVersion && (
          <span className="text-xs text-neutral-400">← {props.previousVersion}</span>
        )}
        <span className="text-xs text-neutral-400">{props.createdAt}</span>
        <div className="ml-auto flex gap-1">
          {(["ko", "en"] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`rounded px-2 py-0.5 text-xs font-medium transition ${
                lang === l
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-500 hover:bg-neutral-100"
              }`}
            >
              {l === "ko" ? "한국어" : "English"}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 whitespace-pre-wrap text-sm text-neutral-700">{body}</div>
      {props.compareUrl && (
        <a
          href={props.compareUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-xs text-blue-600 hover:underline"
        >
          변경 내역 비교 →
        </a>
      )}
    </div>
  );
}
