"use client";

import React, { useState } from "react";
import {
  RELEASE_NOTE_LOCALES,
  releaseNoteTranslations,
  type ReleaseNoteField,
  type ReleaseNoteTranslationsInput,
} from "@/lib/core/release-note-locales";
import { buildGooglePlayReleaseNotesText } from "@/lib/core/store-notes";

export type ReleaseNoteCardProps = {
  appName: string;
  appId: string;
  version: string;
  previousVersion: string | null;
  createdAt: string;
  compareUrl: string | null;
} & ReleaseNoteTranslationsInput;

export function ReleaseNoteCard(props: ReleaseNoteCardProps) {
  const [lang, setLang] = useState<ReleaseNoteField>("koKR");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const notes = releaseNoteTranslations(props);
  const availableLocales = RELEASE_NOTE_LOCALES.filter(({ field }) => notes[field]);
  const selected = availableLocales.some(({ field }) => field === lang)
    ? lang
    : (availableLocales[0]?.field ?? "koKR");
  const body = notes[selected];

  async function copyAndroidReleaseNotes() {
    try {
      await navigator.clipboard.writeText(buildGooglePlayReleaseNotesText(notes));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

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
        <div className="ml-auto flex flex-wrap justify-end gap-1">
          {availableLocales.map(({ field, label }) => (
            <button
              key={field}
              type="button"
              aria-pressed={selected === field}
              onClick={() => setLang(field)}
              className={`rounded px-2 py-0.5 text-xs font-medium transition ${
                selected === field
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-500 hover:bg-neutral-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 whitespace-pre-wrap break-words text-sm text-neutral-700">{body}</div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={copyAndroidReleaseNotes}
          className="rounded border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          title="Google Play Console 언어별 출시노트 형식으로 전체 복사"
        >
          {copyStatus === "copied" ? "✓ Android용 복사됨" : "Android용 전체 복사"}
        </button>
        {copyStatus === "error" && (
          <span className="text-xs text-red-600">클립보드 복사에 실패했습니다.</span>
        )}
        {props.compareUrl && (
          <a
            href={props.compareUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-600 hover:underline"
          >
            변경 내역 비교 →
          </a>
        )}
      </div>
    </div>
  );
}
