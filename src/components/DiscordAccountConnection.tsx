"use client";
import { useState, useTransition } from "react";
import { createDiscordLinkCode, removeDiscordLink } from "@/lib/actions/discord-link";
export function DiscordAccountConnection() {
  const [message, setMessage] = useState("");
  const [busy, start] = useTransition();
  return <div className="my-4 rounded-lg border border-neutral-200 bg-white p-3 text-sm">
    <p className="mb-2 font-semibold">Discord 계정 연결</p>
    <button disabled={busy} className="mr-4 underline" onClick={() => start(async () => {
      try { setMessage(`10분 안에 #backoffice에서 /connect code:${await createDiscordLinkCode()} 를 입력하세요.`); } catch { setMessage("연결 코드 발급 실패. 로그인과 접근 권한을 확인하세요."); }
    })}>연결 코드 발급</button>
    <button disabled={busy} className="underline" onClick={() => start(async () => {
      try { await removeDiscordLink(); setMessage("계정 연결을 해제했습니다."); } catch { setMessage("연결 해제 실패"); }
    })}>내 연결 해제</button>
    <p role="status" className="mt-2 break-all">{message}</p>
  </div>;
}
