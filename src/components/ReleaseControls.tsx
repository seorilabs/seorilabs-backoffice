"use client";

import { useEffect, useState, useTransition } from "react";
import {
  createReleaseAction,
  listAppTagsAction,
  deployAction,
} from "@/lib/actions/release";

const TARGET_LABEL: Record<string, string> = {
  AIT: "AppsInToss",
  PLAY: "Google Play",
  APPSTORE: "App Store",
  ALL: "전체(Deploy All)",
};

// App.marketTargets(소문자) → 배포 대상 후보(+2개 이상이면 ALL).
function targetsFrom(marketTargets: string[]): string[] {
  const out: string[] = [];
  if (marketTargets.includes("ait")) out.push("AIT");
  if (marketTargets.includes("play")) out.push("PLAY");
  if (marketTargets.includes("appstore")) out.push("APPSTORE");
  if (out.length > 1) out.push("ALL");
  return out;
}

export function ReleaseControls({ appId, targets }: { appId: string; targets: string[] }) {
  const markets = targetsFrom(targets);
  const [pending, start] = useTransition();
  const [bump, setBump] = useState("patch");
  const [relMsg, setRelMsg] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState("");
  const [target, setTarget] = useState(markets[0] ?? "");
  const [depMsg, setDepMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listAppTagsAction(appId)
      .then((r) => {
        if (!alive) return;
        setTags(r.tags);
        if (r.tags[0]) setTag(r.tags[0]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [appId]);

  function doRelease() {
    setRelMsg(null);
    start(async () => {
      const r = await createReleaseAction(appId, bump);
      if (r.ok) {
        setRelMsg(`✅ ${r.tag} 생성됨 — GitHub Release + 출시노트 발행`);
        const t = await listAppTagsAction(appId);
        setTags(t.tags);
        if (t.tags[0]) setTag(t.tags[0]);
      } else {
        setRelMsg(`실패: ${r.error}`);
      }
    });
  }

  function doDeploy() {
    if (!tag || !target) return;
    if (!window.confirm(`${tag} → ${TARGET_LABEL[target]} 배포를 실행할까요?`)) return;
    setDepMsg(null);
    start(async () => {
      const r = await deployAction(appId, tag, target);
      setDepMsg(
        r.ok
          ? `🚀 ${TARGET_LABEL[target]} 배포 트리거됨 — 완료 시 알림`
          : `실패: ${r.error}`,
      );
    });
  }

  const btn =
    "rounded border border-neutral-300 px-2.5 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50";
  const primary =
    "rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50";
  const sel = "rounded border border-neutral-300 px-2 py-1 text-sm";

  return (
    <div className="flex flex-col gap-4">
      {/* 릴리즈 태그 생성 + 출시노트 + GitHub Release */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-xs font-medium text-neutral-500">릴리즈</span>
        <select
          value={bump}
          onChange={(e) => setBump(e.target.value)}
          disabled={pending}
          className={sel}
        >
          <option value="patch">patch</option>
          <option value="minor">minor</option>
          <option value="major">major</option>
        </select>
        <button onClick={doRelease} disabled={pending} className={primary}>
          🚀 릴리즈 태그 생성
        </button>
        {relMsg && <span className="text-xs text-neutral-600">{relMsg}</span>}
      </div>

      {/* 릴리즈 태그 기준 마켓 배포 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-xs font-medium text-neutral-500">배포</span>
        {markets.length === 0 ? (
          <span className="text-xs text-neutral-400">배포 마켓 미설정</span>
        ) : tags.length === 0 ? (
          <span className="text-xs text-neutral-400">릴리즈 태그 없음 — 먼저 생성하세요</span>
        ) : (
          <>
            <select
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              disabled={pending}
              className={sel}
            >
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={pending}
              className={sel}
            >
              {markets.map((m) => (
                <option key={m} value={m}>
                  {TARGET_LABEL[m]}
                </option>
              ))}
            </select>
            <button onClick={doDeploy} disabled={pending} className={btn}>
              📦 배포
            </button>
          </>
        )}
        {depMsg && <span className="text-xs text-neutral-600">{depMsg}</span>}
      </div>

      <p className="text-[11px] text-neutral-400">
        릴리즈 태그는 명시적으로 생성되며, 마켓 배포는 태그를 기준으로 트리거됩니다. 결과는 워크플로 완료 시
        미러/알림으로 반영됩니다.
      </p>
    </div>
  );
}
