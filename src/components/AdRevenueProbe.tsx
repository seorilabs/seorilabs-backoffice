"use client";

import { useState, useTransition } from "react";
import { adRevenueProbe, type AdProbeResult } from "@/lib/actions/analytics";

export function AdRevenueProbe() {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [data, setData] = useState<AdProbeResult | null>(null);

  function run() {
    setMsg(null);
    startTransition(async () => {
      try {
        const r = await adRevenueProbe();
        setData(r);
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "실패");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <button
          type="button"
          disabled={pending}
          onClick={run}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          광고/수익 export 진단
        </button>
        <p className="mt-1.5 text-xs text-neutral-500">
          최근 14일 GA4 export 에서 실제 <code>ad_impression</code> 노출과 노출수준 수익(value)
          export 동작 여부를 앱별로 확인합니다.
        </p>
      </div>

      {pending && <p className="text-xs text-neutral-500">BigQuery 조회 중… (앱 수에 따라 수십 초)</p>}
      {msg && <p className="text-xs text-red-600">{msg}</p>}

      {data && (
        <div className="space-y-2">
          <div className="text-xs text-neutral-500">
            기준일 {data.endDate} · 최근 {data.windowDays}일
            {data.skipped.length > 0 && ` · 매핑없음 ${data.skipped.length}개 제외`}
          </div>
          {!data.ga4Configured && (
            <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-700">
              GA4 미설정(FEATURE_GA4_ANALYTICS + GA4_SA_KEY_JSON) — BigQuery 조회를 생략했습니다.
              아래는 앱 매핑 현황만 표시합니다.
            </p>
          )}
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
                  <th className="px-3 py-2">앱</th>
                  <th className="px-3 py-2 text-right">ad_impression</th>
                  <th className="px-3 py-2 text-right">리워드</th>
                  <th className="px-3 py-2 text-right">추정수익</th>
                  <th className="px-3 py-2">수익 export</th>
                </tr>
              </thead>
              <tbody>
                {data.apps.map((a) => (
                  <tr key={a.slug} className="border-b border-neutral-100 last:border-0">
                    <td className="px-3 py-1.5">
                      <div className="font-medium text-neutral-800">{a.displayName}</div>
                      {a.error && <div className="text-[11px] text-red-500">{a.error}</div>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {a.adImpressions.toLocaleString()}
                      {!a.hasAdImpression && !a.error && (
                        <span className="ml-1 text-[11px] text-neutral-400">(없음)</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600">
                      {a.rewardedImpressions.toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {a.hasRevenue
                        ? `${a.estRevenue.toLocaleString()} ${a.currencies ?? ""}`.trim()
                        : "—"}
                    </td>
                    <td className="px-3 py-1.5">
                      {a.error ? (
                        <Tag tone="neutral">오류</Tag>
                      ) : a.hasRevenue ? (
                        <Tag tone="green">동작</Tag>
                      ) : a.hasAdImpression ? (
                        <Tag tone="amber">노출만</Tag>
                      ) : (
                        <Tag tone="neutral">미검출</Tag>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] leading-relaxed text-neutral-500">
            <b>동작</b>=AdMob 노출수준 수익 export 정상(추정수익·ARPDAU 지표화 가능) ·{" "}
            <b>노출만</b>=ad_impression 은 있으나 value 미포함(AdMob 연동/수익 export 설정 필요) ·{" "}
            <b>미검출</b>=ad_impression 이벤트 자체 없음
          </p>
        </div>
      )}
    </div>
  );
}

function Tag({ tone, children }: { tone: "green" | "amber" | "neutral"; children: React.ReactNode }) {
  const cls =
    tone === "green"
      ? "bg-emerald-50 text-emerald-700"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700"
        : "bg-neutral-100 text-neutral-500";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}
