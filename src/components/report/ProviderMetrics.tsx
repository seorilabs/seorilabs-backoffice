"use client";
import React, { useState } from "react";
import type { ProviderSeries } from "@/lib/analytics/report-query";
import { METRIC_DICTIONARY } from "@/lib/analytics/unified-metrics";
import { metricDayWindow } from "@/lib/analytics/metric-day";
import { sourceStateLabel } from "@/lib/insights/collection-state";
import { splitSegmentsOnNull } from "@/lib/report/chart-geometry";

const statusLabel = { provisional: "잠정", analyzable: "분석 가능", estimated: "추정 수익", settled: "정산 확인" };
const number = (value: number | null) => value === null ? "미확인" : new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value);
export function ProviderMetrics({ series }: { series: ProviderSeries[] }) {
  const [appId, setAppId] = useState(""), [metric, setMetric] = useState("");
  const choices = series.filter((row) => (!appId || row.appId === appId) && (!metric || row.metric === metric));
  const apps = [...new Map(series.map((row) => [row.appId, row.appName])).entries()];
  const metrics = [...new Set(series.map((row) => row.metric))];
  return <section aria-label="스토어·광고·품질 분석" className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
    <h2 className="text-base font-semibold">사업 흐름 · 스토어·광고·품질</h2>
    <p className="mt-2 text-xs text-neutral-600">발견 → 다운로드 → 설치 → 첫 핵심 행동 → 재방문 → 수익. 서로 다른 소스의 집계는 같은 사용자의 전환율이 아닙니다. 첫 핵심 행동의 순서·분모가 확인되지 않은 앱은 계측 과제로 남깁니다.</p>
    {!series.length ? <p className="mt-3 text-sm text-neutral-600">확인된 공식 보고서 자료가 아직 없습니다. 아래 수집 현황에서 권한·최초 보고서 생성·자료 도착 상태를 확인하세요.</p> : <>
      <div className="my-4 flex flex-wrap gap-3 text-sm">
        <label>앱 <select aria-label="분석 앱" className="ml-2 max-w-60 rounded border p-2" value={appId} onChange={(event) => setAppId(event.target.value)}><option value="">전체 앱</option>{apps.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>지표 <select aria-label="분석 지표" className="ml-2 max-w-60 rounded border p-2" value={metric} onChange={(event) => setMetric(event.target.value)}><option value="">전체 지표</option>{metrics.map((key) => <option key={key} value={key}>{METRIC_DICTIONARY[key].label}</option>)}</select></label>
      </div>
      <div className="space-y-3">{choices.map((row) => <Series key={[row.appId, row.source, row.account, row.resource, row.reportType, row.metric, row.segment, row.currency, row.timeZone].join(":")} series={row} />)}</div>
    </>}
  </section>;
}
function Series({ series }: { series: ProviderSeries }) {
  const [dimension, setDimension] = useState("");
  const latest = series.points.at(-1)!, assessed = series.points.find((point) => point.day === series.assessmentDay), definition = METRIC_DICTIONARY[series.metric], unit = series.currency ?? series.unit;
  const dimensions = [...new Set(series.dimensions.flatMap((row) => Object.keys(row.labels)))];
  const days = metricDayWindow(latest.day, 28), values = days.map((day) => series.points.find((point) => point.day === day)?.value ?? null);
  const present = values.filter((value): value is number => value !== null), min = Math.min(0, ...present), max = Math.max(1, ...present);
  const x = (index: number) => 52 + index * 600 / 27, y = (value: number) => 160 - (value - min) * 130 / (max - min);
  return <details className="rounded-lg border border-neutral-200">
    <summary className="cursor-pointer px-3 py-3 text-sm"><b>{series.appName} · {definition.label}{series.segment ? ` · ${series.segment}` : ""}</b><span className="ml-2">{number(latest.value)} {unit}</span><span className="ml-2 text-xs text-neutral-600">{latest.day} · {series.timeZone} · {statusLabel[latest.valueStatus]}</span></summary>
    <div className="space-y-3 border-t p-3 text-xs text-neutral-600">
      <p>{series.definition} · {series.source} · {series.reportType} · 계정 {series.account}</p>
      <p>판단 기준일 {series.assessmentDay ?? "분석 가능한 자료 없음"} · 판단: {({ insufficient: "비교 근거 부족", flat: "기준을 넘는 변화 없음", observing: "연속 관측 대기", highlight: "좋아진 점", lowlight: "나빠진 점" })[series.verdict]} · {assessed?.numerator !== null && assessed?.numerator !== undefined ? `분자 ${number(assessed.numerator)} / 분모 ${number(assessed.denominator)}` : "비율 분모 해당 없음"}</p>
      <p>최근 4주 같은 요일: {series.weekdayBaseline === null ? `${series.weekdayObservations}/4일 확보 · 비교 보류` : `중앙값 ${number(series.weekdayBaseline)} ${unit}`}</p>
      <svg viewBox="0 0 720 200" role="img" aria-label={`${series.appName} ${definition.label} 28일 추이, 단위 ${unit}. 빈 구간은 미확인.`} className="h-auto w-full">
        <text x="2" y="20" fontSize="11">{number(max)} {unit}</text><text x="2" y="174" fontSize="11">{number(min)}</text>
        <line x1="52" x2="652" y1={y(0)} y2={y(0)} stroke="#d4d4d4" />
        {splitSegmentsOnNull(values, x, y).paths.map((path, index) => <path key={index} fill="none" stroke="#2563eb" strokeWidth="2" d={path} />)}
        {values.map((value, index) => value === null ? null : <circle key={index} cx={x(index)} cy={y(value)} r="2" fill="#2563eb"><title>{days[index]}: {number(value)} {unit}</title></circle>)}
        <text x="52" y="194" fontSize="11">{days[0]}</text><text x="570" y="194" fontSize="11">{latest.day}</text>
      </svg>
      <details><summary className="cursor-pointer underline">날짜별 수치·원천·표본</summary><div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left"><caption className="sr-only">날짜별 원천 근거</caption><thead><tr><th>기준일</th><th>값({unit})</th><th>분자/분모</th><th>상태</th><th>원천</th></tr></thead><tbody>{series.points.map((point) => <tr className="border-b" key={point.day}><td className="py-2">{point.day}</td><td>{number(point.value)}</td><td>{number(point.numerator)} / {number(point.denominator)}</td><td>{point.state === "empty" ? "확인된 0" : sourceStateLabel(point.state)} · {statusLabel[point.valueStatus]}</td><td><a className="underline" href={point.sourceUri} target="_blank" rel="noreferrer">공식 출처</a><p className="break-all">SHA256 {point.sourceHash}</p><p className="break-all">실행 {point.runId}</p></td></tr>)}</tbody></table></div></details>
      <label>차원 <select className="ml-2 rounded border p-2" value={dimension} onChange={(event) => setDimension(event.target.value)}><option value="">원천 행 전체</option>{dimensions.map((name) => <option key={name}>{name}</option>)}</select></label>
      <details><summary className="cursor-pointer underline">최신 기준일의 국가·버전·유입·광고 형식 원천 행 ({series.dimensions.length}개 · 최대 200행 표시, 전체는 수집 원본 보존)</summary><div className="max-h-80 overflow-auto"><table className="w-full text-left"><caption className="sr-only">최신 기준일의 원천 차원</caption><thead><tr><th>차원</th><th>값({unit})</th><th>수집 상태</th></tr></thead><tbody>{series.dimensions.map((row, index) => <tr className="border-b" key={index}><td className="py-2">{Object.entries(row.labels).filter(([key]) => !dimension || key === dimension).map(([key, value]) => `${key}: ${value}`).join(" · ") || "전체"}</td><td>{number(row.value)}</td><td>{row.state === "empty" ? "확인된 0" : sourceStateLabel(row.state)}</td></tr>)}</tbody></table></div></details>
    </div>
  </details>;
}
