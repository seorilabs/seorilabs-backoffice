"use client";

import { useEffect, useState, useTransition } from "react";
import {
  createReleaseAction,
  listAppTagsAction,
  deployAction,
  promoteToProductionAction,
  prepareAppStoreAction,
  submitAppStoreAction,
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
  const [explicitTag, setExplicitTag] = useState("");
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
      const r = await createReleaseAction(appId, bump, explicitTag);
      if (r.ok) {
        setRelMsg(`✅ ${r.tag} + GitHub Release 생성됨 — 출시노트 번역 중`);
        setExplicitTag("");
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

  const [subMsg, setSubMsg] = useState<string | null>(null);

  function doPromote() {
    if (!tag) return;
    if (!window.confirm(`${tag} 의 내부 빌드를 Google Play 프로덕션으로 승격(심사 제출)할까요?`))
      return;
    setSubMsg(null);
    start(async () => {
      const r = await promoteToProductionAction(appId, tag);
      setSubMsg(
        r.ok ? `⬆️ 프로덕션 승격 트리거됨 — 완료 시 알림` : `실패: ${r.error}`,
      );
    });
  }

  function doPrepareAppStore() {
    if (!tag) return;
    setSubMsg(null);
    start(async () => {
      const r = await prepareAppStoreAction(appId, tag);
      setSubMsg(
        !r.ok
          ? `실패: ${r.error}`
          : r.ready
            ? `📝 심사 준비 완료 — 이제 '심사 제출' 가능`
            : `⏳ 준비됨(노트 반영). ${r.reason ?? "빌드 처리 대기 중"}`,
      );
    });
  }

  function doSubmitAppStore() {
    if (!tag) return;
    if (!window.confirm(`${tag} 를 App Store 심사에 제출할까요? (되돌리기 어려움)`)) return;
    setSubMsg(null);
    start(async () => {
      const r = await submitAppStoreAction(appId, tag);
      setSubMsg(r.ok ? `🚀 App Store 심사 제출됨` : `실패: ${r.error}`);
    });
  }

  const btn =
    "rounded border border-neutral-300 px-2.5 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50";
  const primary =
    "rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50";
  const sel = "rounded border border-neutral-300 px-2 py-1 text-sm";

  return (
    <div className="flex flex-col gap-4">
      {/* 릴리즈 태그 + GitHub Release 즉시 생성, 출시노트는 webhook 후 비동기 생성 */}
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
        <input
          type="text"
          value={explicitTag}
          onChange={(event) => setExplicitTag(event.target.value)}
          disabled={pending}
          placeholder="직접 지정 v1.2.3 - 선택"
          aria-label="직접 지정 릴리즈 태그"
          className="w-44 rounded border border-neutral-300 px-2 py-1 text-sm"
        />
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

      {/* 업로드 이후 마켓 마무리: Google 프로덕션 승격 / App Store 심사 준비·제출 */}
      {tags.length > 0 && (markets.includes("PLAY") || markets.includes("APPSTORE")) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-20 text-xs font-medium text-neutral-500">심사</span>
          {markets.includes("PLAY") && (
            <button onClick={doPromote} disabled={pending} className={btn} title="내부 빌드를 재빌드 없이 프로덕션 트랙으로 승격 + 심사 제출">
              ⬆️ Play 프로덕션 승격
            </button>
          )}
          {markets.includes("APPSTORE") && (
            <>
              <button onClick={doPrepareAppStore} disabled={pending} className={btn} title="App Store 버전 생성 + 언어별 what's new + 빌드 연결">
                📝 심사 준비
              </button>
              <button onClick={doSubmitAppStore} disabled={pending} className={btn} title="App Store 심사에 제출(되돌리기 어려움)">
                🚀 심사 제출
              </button>
            </>
          )}
          {subMsg && <span className="text-xs text-neutral-600">{subMsg}</span>}
        </div>
      )}

      <p className="text-[11px] text-neutral-400">
        릴리즈 태그는 명시적으로 생성되며, 마켓 배포는 태그를 기준으로 트리거됩니다. 결과는 워크플로 완료 시
        미러/알림으로 반영됩니다.
      </p>
    </div>
  );
}
