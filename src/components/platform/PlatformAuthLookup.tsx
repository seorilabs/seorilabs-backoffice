"use client";

import { useState, useTransition } from "react";

import { lookupPlatformUserAction } from "@/lib/actions/platform-read";

import {
  PlatformAuthUserResult,
  type PlatformAuthLookupState,
  type PlatformAuthUserView,
} from "./PlatformAuthUserResult";

export function PlatformAuthLookup() {
  const [reference, setReference] = useState("");
  const [state, setState] = useState<PlatformAuthLookupState>("idle");
  const [user, setUser] = useState<PlatformAuthUserView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("loading");
    setUser(null);
    setMessage(null);
    startTransition(async () => {
      const result = await lookupPlatformUserAction(reference);
      if (!result.ok) {
        setState(
          result.code === "user_not_found" || result.code === "not_found"
            ? "not_found"
            : "error",
        );
        setMessage(result.error);
        return;
      }
      setUser({
        ...result.data,
        blocked: null,
        activeRefreshSessions: null,
        credentialKind: result.data.isAnonymous ? "anonymous" : "signed",
      });
      setState("found");
    });
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={submit}
        className="rounded-lg border border-neutral-200 bg-white p-4"
      >
        <label
          htmlFor="platform-user-reference"
          className="text-sm font-semibold text-neutral-800"
        >
          플랫폼 사용자 조회
        </label>
        <p className="mt-1 text-xs text-neutral-500">
          PII 대신 플랫폼 사용자 ID 또는 지원 코드의 정확한 값으로만 조회합니다.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            id="platform-user-reference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder="pu_… 또는 LT-XXXXXXXX"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={64}
            className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2 font-mono text-sm outline-none focus:border-neutral-600"
          />
          <button
            type="submit"
            disabled={pending || reference.trim() === ""}
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "조회 중…" : "조회"}
          </button>
        </div>
      </form>

      <PlatformAuthUserResult state={state} user={user} message={message} />
    </div>
  );
}
