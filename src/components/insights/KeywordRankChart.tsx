"use client";

import React, { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { KeywordApp } from "@/lib/market/keyword-monitoring";
import { keywordHistoryUrl, rankY, type KeywordSelection, type RankHistory } from "@/lib/market/keyword-history";
import { shiftMetricDay } from "@/lib/analytics/metric-day";
import { splitSegmentsOnNull } from "@/lib/report/chart-geometry";
import { kstDateTimeShort } from "@/lib/format/kst";

const colors = ["#1d4ed8", "#c2410c", "#7e22ce", "#15803d"];
const dashes = [undefined, "6 3", "2 3", "8 3 2 3"];
const control = "min-h-11 rounded border border-neutral-300 px-3 py-2 text-sm";
const lightControl = control + " bg-white";
const filterControl = lightControl + " min-w-0 w-full";
const shortDay = (day: string) => day.slice(5).replace("-", "/");
const countryLabel = (country: string) => `${country === "kr" ? "한국" : country === "us" ? "미국" : country.toUpperCase()} ${country.toUpperCase()}`;
const timeLabel = (at: string | null) => at ? kstDateTimeShort(new Date(at)) + " KST" : "—";

export function KeywordRankChart({ apps, app, selection, history, today }: {
  apps: KeywordApp[]; app: KeywordApp; selection: KeywordSelection; history: RankHistory; today: string;
}) {
  const router = useRouter(), [pending, transition] = useTransition();
  const [ready, setReady] = useState(false);
  const busy = !ready || pending;
  const [warning, setWarning] = useState("");
  const [detailDay, setDetailDay] = useState(selection.day);
  const [dayDraft, setDayDraft] = useState(selection.day);
  useEffect(() => setDayDraft(selection.day), [selection.day]);
  const plot = useRef<HTMLDivElement>(null), [width, setWidth] = useState(320);
  const url = keywordHistoryUrl(selection);
  useEffect(() => {
    if (window.location.pathname + window.location.search !== url) window.history.replaceState(null, "", url);
    setReady(true);
  }, [url]);
  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const navigate = (patch: Partial<KeywordSelection>) => {
    setWarning("");
    transition(() => router.push(keywordHistoryUrl({ ...selection, ...patch, notice: false }), { scroll: false }));
  };
  const toggle = (term: string) => {
    if (!selection.terms.includes(term) && selection.terms.length >= 4) { setWarning("검색어는 최대 4개까지 비교할 수 있습니다."); return; }
    navigate({ terms: selection.terms.includes(term) ? selection.terms.filter(item => item !== term) : [...selection.terms, term] });
  };
  const detailIndex = history.dates.indexOf(history.dates.includes(detailDay) ? detailDay : selection.day);
  const left = 52, right = Math.max(left + 1, width - 16), top = 24, bottom = 224;
  const x = (index: number) => left + index / Math.max(1, history.dates.length - 1) * (right - left);
  const y = (rank: number) => rankY(rank, top, bottom);
  const ticks = width < 440 ? [0, Math.floor((history.dates.length - 1) / 2), history.dates.length - 1] : [0, Math.floor((history.dates.length - 1) / 3), Math.floor((history.dates.length - 1) * 2 / 3), history.dates.length - 1];
  const [statusTerm, setStatusTerm] = useState(selection.terms[0] ?? "");
  const statusSeries = history.series.find(series => series.term === statusTerm) ?? history.series[0];
  const latestSeriesPoints = statusSeries?.points.slice(-7) ?? [];
  return <div className="space-y-4" aria-busy={busy}>
    <p className="text-xs text-neutral-600">App Store · 매일 21:20 KST 수집 · Apple 검색 API 최대 200개 결과의 순서로, 실제 기기 검색 화면과 다를 수 있습니다.</p>
    {selection.notice && <p role="status" className="text-sm text-amber-800">입력값을 확인해 조회 가능한 앱·국가·기간으로 바꿨습니다.</p>}
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid min-w-0 flex-[2_1_13.75rem] gap-1 text-sm">앱<select aria-label="앱" className={filterControl} value={app.id} disabled={busy} onChange={event => {
        const next = apps.find(item => item.id === event.target.value)!;
        navigate({ appId: next.id, country: next.countries[0], terms: next.keywords.slice(0, 2) });
      }}>{apps.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      <label className="grid min-w-0 flex-[1_1_7.5rem] gap-1 text-sm">국가<select aria-label="국가" className={filterControl} value={selection.country} disabled={busy} onChange={event => navigate({ country: event.target.value })}>{app.countries.map(country => <option key={country} value={country}>{countryLabel(country)}</option>)}</select></label>
      <label className="grid min-w-0 flex-[1_1_9.375rem] gap-1 text-sm">기준일<input aria-label="기준일" aria-describedby="keyword-date-help" type="date" max={today} value={dayDraft} className={filterControl} disabled={busy} onChange={event => setDayDraft(event.target.value)} onBlur={event => {
        const day = event.currentTarget.value;
        if (!day) setDayDraft(selection.day);
        else if (event.currentTarget.validity.valid && day !== selection.day) navigate({ day });
      }} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); if (event.currentTarget.reportValidity()) event.currentTarget.blur(); }
      }} /></label>
      <div className="min-w-0 max-w-full"><p className="mb-1 text-sm">기간</p><div className="flex flex-wrap gap-1">{[7, 30, 90].map(days => <button type="button" key={days} disabled={busy} aria-pressed={selection.days === days} className={control + (selection.days === days ? " border-neutral-900 bg-neutral-900 text-white" : " bg-white")} onClick={() => navigate({ days })}>{days}일</button>)}</div></div>
      <div className="flex flex-wrap gap-1">
        <button type="button" className={lightControl} disabled={busy} onClick={() => navigate({ day: shiftMetricDay(selection.day, -1) })}>전일</button>
        <button type="button" className={lightControl} disabled={busy || selection.day >= today} onClick={() => navigate({ day: shiftMetricDay(selection.day, 1) })}>익일</button>
        <button type="button" className={lightControl} disabled={busy || selection.day === today} onClick={() => navigate({ day: today })}>오늘</button>
      </div>
    </div>
    <p id="keyword-date-help" className="text-xs text-neutral-600">기준일을 입력한 뒤 Enter 또는 다른 곳을 누르면 조회합니다.</p>
    <p role="status" className="text-xs text-neutral-600">{!ready ? "화면 준비 중…" : pending ? "DB 기록 조회 중…" : `${app.displayName} · ${countryLabel(selection.country)} · ${history.dates[0]}~${selection.day} · 현재 설정 버전 ${app.revision ?? "미상"}`}</p>
    <section className="rounded-lg border border-neutral-200 bg-white p-4" aria-labelledby="keyword-trend-title">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="keyword-trend-title" className="font-semibold">검색어별 순위 추이</h2><span className="text-xs text-neutral-600">1위가 위쪽 · 최대 4개 비교</span></div>
      <div className="my-3 flex flex-wrap gap-x-4 gap-y-1">{app.keywords.map(term => {
        const index = selection.terms.indexOf(term);
        return <label key={term} className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" aria-label={term + " 추이 비교"} checked={index >= 0} disabled={busy} onChange={() => toggle(term)} />{index >= 0 && <svg aria-hidden width="24" height="12" className="shrink-0"><line x1="0" x2="24" y1="6" y2="6" stroke={colors[index]} strokeWidth="2" strokeDasharray={dashes[index]} /></svg>}{term}</label>;
      })}</div>
      {warning && <p role="alert" className="mb-2 text-sm text-amber-800">{warning}</p>}
      <div ref={plot} className="min-w-0">
        {history.series.length ? <svg data-testid="keyword-rank-chart" viewBox={`0 0 ${width} 274`} className="block h-[274px] w-full" role="img" aria-label={`${app.displayName} ${countryLabel(selection.country)} 검색 순위 추이`}>
          <title>{`검색어별 순위 추이 · ${history.dates[0]}~${selection.day}`}</title><desc>1위는 위쪽, 200위는 아래쪽입니다. 없는 날짜와 결과 목록에 없는 관측은 선을 끊습니다. 날짜별 수치와 상태는 아래 표에서 확인할 수 있습니다.</desc>
          <text x={left} y={13} fontSize={12} fill="#525252">순위</text>
          {[1, 50, 100, 150, 200].map(rank => <g key={rank}><line x1={left} x2={right} y1={y(rank)} y2={y(rank)} stroke="#e5e5e5" /><text x={left - 8} y={y(rank) + 4} textAnchor="end" fontSize={12} fill="#525252">{rank}위</text></g>)}
          {ticks.map((index, slot) => <text key={index} x={x(index)} y={248} textAnchor={slot === 0 ? "start" : slot === ticks.length - 1 ? "end" : "middle"} fontSize={12} fill="#525252">{shortDay(history.dates[index])}</text>)}
          <text x={right} y={268} textAnchor="end" fontSize={12} fill="#525252">날짜 · KST</text>
          {history.series.map((series, index) => {
            const segments = splitSegmentsOnNull(series.points.map(point => point.rank), x, y);
            return <g key={series.term} data-series={series.term}>{segments.paths.map((path, slot) => <path key={slot} d={path} fill="none" stroke={colors[index]} strokeWidth={2.4} strokeDasharray={dashes[index]} />)}{series.points.map((point, slot) => point.rank !== null && <circle key={point.day} cx={x(slot)} cy={y(point.rank)} r={3} fill={colors[index]}><title>{`${point.day} · ${series.term} ${point.label}`}</title></circle>)}</g>;
          })}
          <line x1={x(detailIndex)} x2={x(detailIndex)} y1={top} y2={bottom} stroke="#737373" opacity={0.35} />
          <rect x={left} y={top} width={right - left} height={bottom - top} fill="transparent" onPointerMove={event => {
            if (busy) return;
            const box = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
            const index = Math.max(0, Math.min(history.dates.length - 1, Math.round((event.clientX - box.left - left) / (right - left) * (history.dates.length - 1))));
            setDetailDay(history.dates[index]);
          }} onPointerDown={event => { if (busy) return; const box = event.currentTarget.ownerSVGElement!.getBoundingClientRect(); setDetailDay(history.dates[Math.max(0, Math.min(history.dates.length - 1, Math.round((event.clientX - box.left - left) / (right - left) * (history.dates.length - 1))))]); }} />
        </svg> : <p className="py-8 text-sm text-neutral-600">비교할 검색어를 선택하세요.</p>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-3 text-sm"><label>그래프 상세 날짜 <select aria-label="그래프 상세 날짜" disabled={busy} value={history.dates[detailIndex]} className={lightControl} onChange={event => setDetailDay(event.target.value)}>{[...history.dates].reverse().map(day => <option key={day}>{day}</option>)}</select></label>{history.series.map(series => <span key={series.term}>{series.term} · {series.points[detailIndex].label}{series.points[detailIndex].attemptState === "수집 실패" && series.points[detailIndex].observedAt ? " · 최근 수집 실패" : ""}</span>)}</div>
      <p className="mt-2 text-xs text-neutral-600">미수집·실패·결과 목록에 없는 날은 선을 끊습니다. 성공 관측 이후 재시도가 실패한 날은 저장된 관측과 시각을 함께 표시합니다.</p>
      {history.series.length > 0 && history.series.every(series => series.points.every(point => point.observationState === "missing")) && <p className="mt-2 text-sm text-neutral-600">기간 내 저장된 관측이 없습니다. 수집 상태를 확인하세요.</p>}
      {history.series.length > 0 && history.series.every(series => series.points.every(point => point.observationState === "outside")) && <p className="mt-2 text-sm text-neutral-600">기간 내 모든 관측이 결과 목록에 없습니다.</p>}
      <details className="mt-3 text-sm"><summary>날짜별 자료 표로 보기</summary><div className="mt-2 overflow-x-auto" role="region" aria-label="날짜별 순위 자료" tabIndex={0}><table className="w-full text-left text-sm"><thead><tr><th className="p-2">날짜 KST</th>{history.series.map(series => <th key={series.term} className="p-2">{series.term}</th>)}</tr></thead><tbody>{history.dates.map((day, index) => <tr key={day} className="border-t border-neutral-100"><td className="p-2 whitespace-nowrap">{day}</td>{history.series.map(series => <td className="p-2" key={series.term}>{series.points[index].label}{series.points[index].attemptState === "수집 실패" && series.points[index].observedAt ? " · 최근 수집 실패" : ""}</td>)}</tr>)}</tbody></table></div></details>
    </section>
    <section className="rounded-lg border border-neutral-200 bg-white p-4" aria-labelledby="keyword-daily-title">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="keyword-daily-title" className="font-semibold">{selection.day} 검색 순위표</h2><Link className="text-sm text-blue-700" href={`/feedback?date=${selection.day}#daily-search-ranks`}>전체 앱 순위표 →</Link></div>
      <p className="mt-1 text-xs text-neutral-600">현재 추적 검색어 {history.rows.length}개 · 성공 관측 {history.rows.filter(row => ["ranked", "outside"].includes(row.observationState)).length}개 · 변화는 이전 마지막 성공 관측과 비교합니다.</p>
      <div className="mt-3 overflow-x-auto" role="region" aria-label="기준일 검색 순위표" tabIndex={0}><table className="w-full min-w-[850px] text-left text-sm"><thead><tr>{["검색어", "순위·상태", "변화", "이전 성공 관측", "성공 관측 시각", "최근 시도", "추이"].map(label => <th className="p-2 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{history.rows.map(row => <tr key={row.term} className="border-t border-neutral-100"><td className="p-2"><a href={row.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-700">{row.term}</a></td><td className="p-2 font-medium whitespace-nowrap">{row.label}</td><td className="p-2 whitespace-nowrap">{row.change}</td><td className="p-2">{row.previousDay ? `${row.previousRank === null ? "결과 목록에 없음" : row.previousRank + "위"} · ${row.previousDay}` : "비교 자료 없음"}</td><td className="p-2">{timeLabel(row.observedAt)}</td><td className="p-2">{row.attemptState ?? "시도 기록 없음"}<br />{timeLabel(row.attemptedAt)}</td><td className="p-2"><button type="button" disabled={busy} aria-label={row.term + " " + (selection.terms.includes(row.term) ? "비교 중" : "비교하기")} onClick={() => toggle(row.term)} className={lightControl + " whitespace-nowrap"}>{selection.terms.includes(row.term) ? "비교 중" : "비교하기"}</button></td></tr>)}</tbody></table></div>
      <p className="mt-2 text-xs text-neutral-600">당일 미수집은 이전 순위로 채우지 않습니다. 설정에서 제거된 검색어의 기존 DB 기록은 보존됩니다.</p>
    </section>
    {statusSeries && <section className="rounded-lg border border-neutral-200 bg-white p-4"><h2 className="font-semibold">최근 7일 수집 상태</h2><label className="mt-3 flex flex-wrap items-center gap-2 text-sm">검색어<select aria-label="수집 상태 검색어" disabled={busy} className={lightControl} value={statusSeries.term} onChange={event => setStatusTerm(event.target.value)}>{history.series.map(series => <option key={series.term}>{series.term}</option>)}</select></label><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-7">{latestSeriesPoints.map(point => <div key={point.day} className="rounded bg-neutral-50 p-2 text-sm"><span className="text-xs text-neutral-600">{shortDay(point.day)}</span><p>{point.label}</p>{point.attemptState === "수집 실패" && point.observedAt && <p className="text-xs text-amber-800">최근 수집 실패</p>}</div>)}</div></section>}
    <div className="flex flex-wrap gap-4 text-sm"><Link href={`/apps/${app.id}/fleet`} className="text-blue-700">추적 검색어·국가 설정 →</Link><Link href="/settings/health" className="text-blue-700">수집 상태 →</Link></div>
  </div>;
}
