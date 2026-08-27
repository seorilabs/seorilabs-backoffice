"use client";

import { useState, useTransition } from "react";
import { setPlayInternalTestUrlAction } from "@/lib/actions/release";

/**
 * Play 내부 테스트 바로가기 링크 입력.
 *
 * opt-in URL(play.google.com/apps/internaltest/<id>)은 패키지명에서 파생되지 않아
 * Play Console 에서 한 번 복사해 넣어야 한다. 저장하면 Discord Play 배포 카드에
 * 링크 버튼이 붙고, 비우면 버튼이 사라진다.
 */
export function PlayInternalTestControl({
  appId,
  url,
}: {
  appId: string;
  url: string | null;
}) {
  const [value, setValue] = useState(url ?? "");
  const [saved, setSaved] = useState(url ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setMsg(null);
    start(async () => {
      const result = await setPlayInternalTestUrlAction(appId, value);
      if (!result.ok) {
        setMsg(`실패: ${result.error}`);
        return;
      }
      const next = result.url ?? "";
      setValue(next);
      setSaved(next);
      setMsg(next ? "✅ 저장됨 — 배포 카드에 링크 버튼이 붙습니다" : "✅ 비웠습니다 — 링크 버튼 없음");
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 shrink-0 text-xs font-medium text-neutral-500">내부 테스트</span>
      <input
        type="url"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={pending}
        placeholder="https://play.google.com/apps/internaltest/..."
        aria-label="Play 내부 테스트 바로가기 링크"
        className="w-96 max-w-full rounded border border-neutral-300 px-2 py-1 text-sm"
      />
      <button
        type="button"
        onClick={save}
        disabled={pending || value.trim() === saved}
        className="rounded border border-neutral-300 px-2.5 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? "저장중…" : "저장"}
      </button>
      {saved && (
        <a
          href={saved}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-blue-700 underline"
        >
          열기
        </a>
      )}
      {msg && <span className="text-xs text-neutral-600">{msg}</span>}
    </div>
  );
}
