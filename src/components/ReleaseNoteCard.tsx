"use client";

import React, { useState } from "react";
import {
  RELEASE_NOTE_LOCALES,
  releaseNoteTranslations,
  type ReleaseNoteField,
  type ReleaseNoteTranslationsInput,
} from "@/lib/core/release-note-locales";

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
  const notes = releaseNoteTranslations(props);
  const availableLocales = RELEASE_NOTE_LOCALES.filter(({ field }) => notes[field]);
  const selected = availableLocales.some(({ field }) => field === lang)
    ? lang
    : (availableLocales[0]?.field ?? "koKR");
  const body = notes[selected];
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
