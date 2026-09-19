"use client";

import React, { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { ReleaseMarket } from "@prisma/client";
import {
  RELEASE_NOTE_LOCALES,
  type ReleaseNoteField,
  type ReleaseNoteTranslations,
} from "@/lib/core/release-note-locales";
import type { ReleaseNoteBodyLoader } from "@/lib/core/release-note-index";
import {
  RELEASE_MARKET_BADGE,
  RELEASE_MARKET_LABEL,
  releaseMarketKey,
} from "@/lib/core/release-markets";
import { buildGooglePlayReleaseNotesText } from "@/lib/core/store-notes";

export type ReleaseNoteDialogButtonProps = {
  noteId: string;
  /** 본문 로더(server action). 팝업을 처음 열 때 한 번만 호출한다. */
  load: ReleaseNoteBodyLoader;
  appName: string;
  version: string;
  /** 마켓 row — 레거시(NULL) row 는 "공통"으로 표기. */
  market: ReleaseMarket | null;
  previousVersion: string | null;
  createdAt: string;
  compareUrl: string | null;
};

type CopyKey = "body" | "play";

/**
 * 목록의 마켓 버튼 + 본문 팝업.
 *
 * 본문은 열 때 서버 액션으로 한 번만 읽고 캐시한다. 팝업 안에서 언어를 고르고,
 * 스토어 입력란에 그대로 넣을 수 있는 형태로 복사한다.
 * - Google Play: Console 언어별 일괄 입력 스키마(`<ko-KR>…</ko-KR>`) 전체 복사
 * - 그 외: 선택한 언어 본문 복사(로케일 코드는 마켓 체계에 맞춰 표기)
 */
export function ReleaseNoteDialogButton(props: ReleaseNoteDialogButtonProps) {
  const marketKey = releaseMarketKey(props.market);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<ReleaseNoteTranslations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<ReleaseNoteField>("koKR");
  const [copied, setCopied] = useState<CopyKey | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [pending, start] = useTransition();
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  function openDialog() {
    setOpen(true);
    setCopied(null);
    setCopyError(false);
    if (notes) return;
    setError(null);
    start(async () => {
      const result = await props.load(props.noteId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotes(result.notes);
    });
  }

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  const available = RELEASE_NOTE_LOCALES.filter(({ field }) => notes?.[field]);
  const selected = available.some(({ field }) => field === lang)
    ? lang
    : (available[0]?.field ?? "koKR");
  const locale = RELEASE_NOTE_LOCALES.find(({ field }) => field === selected);
  const body = notes?.[selected] ?? "";
  // Play 와 App Store 는 로케일 코드 체계가 다르다(ko-KR vs ko). 붙여넣을 칸을 헷갈리지 않게 명시.
  const localeCode = marketKey === "APPSTORE" ? locale?.ascLocale : locale?.storeLocale;

  async function copy(key: CopyKey, text: string) {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied(null);
      setCopyError(true);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        title={`${RELEASE_MARKET_LABEL[marketKey]} 출시노트 열기`}
        className={`rounded px-2 py-0.5 text-xs font-medium transition hover:brightness-95 ${RELEASE_MARKET_BADGE[marketKey]}`}
      >
        {RELEASE_MARKET_LABEL[marketKey]}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`${props.appName} ${props.version} ${RELEASE_MARKET_LABEL[marketKey]} 출시노트`}
        >
          <div className="absolute inset-0 bg-black/40" onClick={close} aria-hidden />
          <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-neutral-200 bg-white shadow-xl">
            <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-3">
              <span className="font-semibold">{props.appName}</span>
              <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs font-medium text-white">
                {props.version}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-medium ${RELEASE_MARKET_BADGE[marketKey]}`}
              >
                {RELEASE_MARKET_LABEL[marketKey]}
              </span>
              {props.previousVersion && (
                <span className="text-xs text-neutral-400">← {props.previousVersion}</span>
              )}
              <span className="text-xs text-neutral-400">{props.createdAt}</span>
              <button
                ref={closeRef}
                type="button"
                onClick={close}
                aria-label="닫기"
                className="ml-auto flex h-7 w-7 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {pending && <p className="text-sm text-neutral-400">본문을 불러오는 중…</p>}
              {error && <p className="text-sm text-red-600">{error}</p>}
              {!pending && !error && available.length === 0 && (
                <p className="text-sm text-neutral-400">이 마켓 row 에는 본문이 없습니다.</p>
              )}
              {available.length > 0 && (
                <>
                  <div className="flex flex-wrap gap-1">
                    {available.map(({ field, label }) => (
                      <button
                        key={field}
                        type="button"
                        aria-pressed={selected === field}
                        onClick={() => {
                          setLang(field);
                          setCopied(null);
                        }}
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
                  {localeCode && (
                    <div className="mt-2 text-xs text-neutral-400">
                      {RELEASE_MARKET_LABEL[marketKey]} 로케일 코드{" "}
                      <code className="rounded bg-neutral-100 px-1 py-0.5 text-neutral-600">
                        {localeCode}
                      </code>
                    </div>
                  )}
                  <div className="mt-3 whitespace-pre-wrap break-words text-sm text-neutral-700">
                    {body}
                  </div>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-neutral-200 px-4 py-3">
              <button
                type="button"
                disabled={!body}
                onClick={() => copy("body", body)}
                className="rounded border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
                title="선택한 언어 본문만 복사"
              >
                {copied === "body" ? "✓ 복사됨" : `${locale?.label ?? "본문"} 복사`}
              </button>
              {marketKey === "PLAY" && (
                <button
                  type="button"
                  disabled={!notes}
                  onClick={() => copy("play", buildGooglePlayReleaseNotesText(notes ?? {}))}
                  className="rounded border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-40"
                  title="Play Console 언어별 출시노트 일괄 입력 스키마(<ko-KR>…</ko-KR>)로 전체 복사"
                >
                  {copied === "play" ? "✓ Play 스키마 복사됨" : "Play 스키마 전체 복사"}
                </button>
              )}
              {copyError && (
                <span className="text-xs text-red-600">클립보드 복사에 실패했습니다.</span>
              )}
              {props.compareUrl && (
                <a
                  href={props.compareUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-xs text-blue-600 hover:underline"
                >
                  변경 내역 비교 →
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
