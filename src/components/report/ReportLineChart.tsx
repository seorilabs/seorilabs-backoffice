import React from "react";
import { niceMax, splitSegmentsOnNull } from "@/lib/report/chart-geometry";

/**
 * Org 보고서 일 단위 시계열 라인 차트.
 *
 * PlatformMetricChart 와 같은 방식 — 차트 라이브러리를 들이지 않고 인라인 SVG 로
 * 그린다(서버 컴포넌트, 클라이언트 상태 없음). x 축은 날짜 격자(오래된→최신)이고
 * 값이 null(그 날 수집 없음)이면 선을 끊는다. 색만으로 식별하게 두지 않기 위해
 * 직접 라벨(계열명+마지막 값)과 표 폴백을 함께 둔다.
 */

export interface ReportChartSeries {
  label: string;
  /** 검증된 categorical 슬롯(--series-1..3). 순서 고정. */
  varName: string;
  /** dates 와 같은 길이. null=그 날 수집 없음(선을 끊는다). */
  values: readonly (number | null)[];
}

export interface ReportLineChartProps {
  title: string;
  note?: string;
  /** "YYYY-MM-DD" 오래된→최신. */
  dates: readonly string[];
  series: readonly ReportChartSeries[];
  format?: "count" | "krw";
}

const VIEW_W = 720;
const VIEW_H = 200;
const PAD_L = 52;
const PAD_R = 108; // 직접 라벨 자리
const PAD_T = 12;
const PAD_B = 24;

const countFormat = new Intl.NumberFormat("ko-KR");

function formatValue(value: number, format: "count" | "krw"): string {
  const rounded = countFormat.format(Math.round(value));
  return format === "krw" ? `₩${rounded}` : rounded;
}

/** 마지막 관측값(최신 쪽에서 첫 non-null). 직접 라벨용. */
function lastObserved(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value != null) return value;
  }
  return null;
}

export function ReportLineChart({ title, note, dates, series, format = "count" }: ReportLineChartProps) {
  const observed = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  if (dates.length === 0 || observed.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="mb-1 text-sm font-semibold text-neutral-700">{title}</div>
        <div className="text-sm text-neutral-400">표시할 시계열이 없습니다.</div>
      </div>
    );
  }

  const max = niceMax(Math.max(1, ...observed));
  const x = (i: number) =>
    dates.length === 1 ? PAD_L : PAD_L + (i / (dates.length - 1)) * (VIEW_W - PAD_L - PAD_R);
  const y = (v: number) => VIEW_H - PAD_B - (v / max) * (VIEW_H - PAD_T - PAD_B);

  return (
    <div className="viz-root rounded-lg border border-neutral-200 bg-white p-4">
      <style>{`
        .viz-root {
          --grid: #e5e5e1;
          --axis-text: #52514e;
          --series-1: #2a78d6;
          --series-2: #eb6834;
          --series-3: #1baf7a;
        }
        @media (prefers-color-scheme: dark) {
          :root:where(:not([data-theme="light"])) .viz-root {
            --grid: #3a3a37;
            --axis-text: #c3c2b7;
            --series-1: #3987e5;
            --series-2: #d95926;
            --series-3: #199e70;
          }
        }
        :root[data-theme="dark"] .viz-root {
          --grid: #3a3a37;
          --axis-text: #c3c2b7;
          --series-1: #3987e5;
          --series-2: #d95926;
          --series-3: #199e70;
        }
      `}</style>

      <div className="mb-1 text-sm font-semibold text-neutral-700">{title}</div>
      {note && <p className="mb-2 text-[11px] leading-4 text-neutral-500">{note}</p>}

      {/* 2개 이상이면 범례를 항상 둔다. 색만으로 식별하게 두지 않는다. */}
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-neutral-600">
          {series.map((sp) => (
            <span key={sp.label} className="inline-flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: `var(${sp.varName})` }}
              />
              {sp.label}
            </span>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-auto w-full min-w-[480px]"
          role="img"
          aria-label={`${title} 시계열`}
        >
          {[0, 0.5, 1].map((frac) => {
            const value = max * frac;
            return (
              <g key={frac}>
                <line
                  x1={PAD_L}
                  x2={VIEW_W - PAD_R}
                  y1={y(value)}
                  y2={y(value)}
                  stroke="var(--grid)"
                  strokeWidth={1}
                />
                <text
                  x={PAD_L - 6}
                  y={y(value) + 3}
                  textAnchor="end"
                  fontSize={9}
                  fill="var(--axis-text)"
                >
                  {formatValue(value, format)}
                </text>
              </g>
            );
          })}

          <text x={PAD_L} y={VIEW_H - 6} fontSize={9} fill="var(--axis-text)">
            {dates[0]}
          </text>
          {dates.length > 1 && (
            <text
              x={VIEW_W - PAD_R}
              y={VIEW_H - 6}
              textAnchor="end"
              fontSize={9}
              fill="var(--axis-text)"
            >
              {dates[dates.length - 1]}
            </text>
          )}

          {series.map((sp) => {
            const { paths, lonePoints } = splitSegmentsOnNull(sp.values, x, y);
            const latest = lastObserved(sp.values);
            return (
              <g key={sp.label}>
                {paths.map((d, i) => (
                  <path
                    key={i}
                    d={d}
                    fill="none"
                    stroke={`var(${sp.varName})`}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {/* 양옆이 결측인 점은 선이 안 보이므로 마커를 남긴다. */}
                {lonePoints.map((point, i) => (
                  <circle key={i} cx={point.x} cy={point.y} r={3.5} fill={`var(${sp.varName})`} />
                ))}
                {/* 직접 라벨: 계열명 + 마지막 관측값. */}
                {latest != null && (
                  <text
                    x={VIEW_W - PAD_R + 8}
                    y={y(latest) + 3}
                    fontSize={10}
                    fill="var(--axis-text)"
                  >
                    {sp.label} {formatValue(latest, format)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <details className="mt-2 text-xs text-neutral-600">
        <summary className="cursor-pointer">표로 보기</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-neutral-200">
                <th className="py-1 pr-3 font-medium">날짜</th>
                {series.map((sp) => (
                  <th key={sp.label} className="py-1 pr-3 font-medium">
                    {sp.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {[...dates]
                .map((date, index) => ({ date, index }))
                .reverse()
                .map(({ date, index }) => (
                  <tr key={date} className="border-b border-neutral-100">
                    <td className="py-1 pr-3">{date}</td>
                    {series.map((sp) => (
                      <td key={sp.label} className="py-1 pr-3">
                        {sp.values[index] == null ? "—" : formatValue(sp.values[index]!, format)}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
