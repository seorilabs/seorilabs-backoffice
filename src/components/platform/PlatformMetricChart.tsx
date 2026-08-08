import React from "react";

import {
  findMetricGaps,
  type PlatformMetricSample,
} from "@/lib/platform/metric-samples";
import { PlatformEmptyState, PlatformPanel } from "./PlatformUi";

/**
 * 플랫폼 지표 시계열.
 *
 * 차트 라이브러리를 들이지 않고 인라인 SVG로 그린다. 선 두 종류가
 * 전부라 의존성을 추가할 만한 규모가 아니다.
 *
 * 활성 사용자와 전체 사용자를 **별도 차트**로 나눈다. 둘은 크기가
 * 자릿수 단위로 달라 한 축에 그리면 활성 곡선이 바닥에 눌린다.
 * 축을 두 개 두는 것은 더 나쁘다 — 두 y축 차트는 눈금 선택만으로
 * 아무 상관관계나 만들어 낼 수 있다.
 */

export interface PlatformMetricChartProps {
  samples: readonly PlatformMetricSample[];
  /** 아직 한 번도 수집하지 않았는지. 장애와 구분해 안내한다. */
  collecting?: boolean;
}

type SeriesKey = keyof Omit<PlatformMetricSample, "capturedAt">;

interface SeriesSpec {
  key: SeriesKey;
  label: string;
  /** 검증된 categorical 슬롯. 순서 고정이고 순환시키지 않는다. */
  varName: string;
}

const ACTIVE_SERIES: SeriesSpec[] = [
  { key: "weeklyActiveUsers", label: "7일", varName: "--series-1" },
  { key: "dailyActiveUsers", label: "24시간", varName: "--series-2" },
  { key: "hourlyActiveUsers", label: "1시간", varName: "--series-3" },
];

const VIEW_W = 720;
const VIEW_H = 200;
const PAD_L = 44;
const PAD_R = 96; // 직접 라벨 자리
const PAD_T = 12;
const PAD_B = 24;

function niceMax(value: number): number {
  if (value <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / mag) * mag;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatHour(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * 결측 구간에서 선을 끊는다.
 *
 * cron이 실패하면 구멍이 생기고 백필이 불가능하다. 이어 그리면 없는
 * 시간에도 그 정도였다는 거짓을 보여준다.
 */
function pathSegments(
  samples: readonly PlatformMetricSample[],
  key: SeriesKey,
  x: (i: number) => number,
  y: (v: number) => number,
): string[] {
  const breaks = new Set(findMetricGaps(samples).map((g) => g.afterIndex));
  const out: string[] = [];
  let current: string[] = [];
  samples.forEach((sample, i) => {
    current.push(`${current.length === 0 ? "M" : "L"}${x(i)},${y(sample[key])}`);
    if (breaks.has(i)) {
      out.push(current.join(" "));
      current = [];
    }
  });
  if (current.length > 0) out.push(current.join(" "));
  // 점이 하나뿐인 구간은 선이 그려지지 않는다. 눈에 보이게 남긴다.
  return out;
}

export function PlatformMetricChart({
  samples,
  collecting = false,
}: PlatformMetricChartProps) {
  if (samples.length === 0) {
    return (
      <PlatformPanel
        title="플랫폼 사용자 추이"
        description="매시 정각에 저장한 시점 스냅샷입니다."
      >
        <PlatformEmptyState title="아직 표시할 시계열이 없습니다">
          {collecting
            ? "매시 정각에 수집합니다. 과거는 복원할 수 없어 수집 시작 시점부터 채워집니다."
            : "수집이 설정되지 않았습니다."}
        </PlatformEmptyState>
      </PlatformPanel>
    );
  }

  const gaps = findMetricGaps(samples);
  const missingHours = gaps.reduce((sum, g) => sum + g.missingHours, 0);

  return (
    <PlatformPanel
      title="플랫폼 사용자 추이"
      description="매시 정각에 저장한 시점 스냅샷입니다. 과거는 복원할 수 없어 수집 시작 시점부터 존재합니다."
    >
      <div className="viz-root space-y-6 p-4">
        <style>{`
          .viz-root {
            --surface-1: #fcfcfb;
            --grid: #e5e5e1;
            --axis-text: #52514e;
            --series-1: #2a78d6;
            --series-2: #eb6834;
            --series-3: #1baf7a;
          }
          @media (prefers-color-scheme: dark) {
            :root:where(:not([data-theme="light"])) .viz-root {
              --surface-1: #1a1a19;
              --grid: #3a3a37;
              --axis-text: #c3c2b7;
              --series-1: #3987e5;
              --series-2: #d95926;
              --series-3: #199e70;
            }
          }
          :root[data-theme="dark"] .viz-root {
            --surface-1: #1a1a19;
            --grid: #3a3a37;
            --axis-text: #c3c2b7;
            --series-1: #3987e5;
            --series-2: #d95926;
            --series-3: #199e70;
          }
        `}</style>

        <ChartBlock
          heading="활성 사용자"
          note="세션 발급·갱신 기준. 창이 다르므로 1시간 값이 가장 작은 것이 정상입니다."
          samples={samples}
          series={ACTIVE_SERIES}
        />

        {/*
          전체 사용자는 자릿수가 달라 같은 축에 둘 수 없다. 축을 둘로
          나누는 대신 차트를 나눈다.
        */}
        <ChartBlock
          heading="전체 사용자"
          note="플랫폼이 발급한 사용자 ID 누적."
          samples={samples}
          series={[
            { key: "totalUsers", label: "전체", varName: "--series-1" },
          ]}
        />

        {missingHours > 0 && (
          <p className="text-xs text-amber-700">
            수집이 누락된 구간이 {missingHours}시간 있어 선을 끊어 그렸습니다.
            과거는 복원할 수 없습니다.
          </p>
        )}

        {/*
          라이트 모드에서 aqua 계열이 표면 대비 3:1 미만이라 색만으로
          식별하게 두면 안 된다. 직접 라벨과 표를 함께 제공한다.
        */}
        <details className="text-xs text-neutral-600">
          <summary className="cursor-pointer">표로 보기</summary>
          <div className="mt-2 max-h-64 overflow-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-neutral-200">
                  <th className="py-1 pr-3 font-medium">시각</th>
                  <th className="py-1 pr-3 font-medium">1시간</th>
                  <th className="py-1 pr-3 font-medium">24시간</th>
                  <th className="py-1 pr-3 font-medium">7일</th>
                  <th className="py-1 font-medium">전체</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {[...samples].reverse().map((s) => (
                  <tr key={s.capturedAt} className="border-b border-neutral-100">
                    <td className="py-1 pr-3">{formatHour(s.capturedAt)}</td>
                    <td className="py-1 pr-3">{formatCount(s.hourlyActiveUsers)}</td>
                    <td className="py-1 pr-3">{formatCount(s.dailyActiveUsers)}</td>
                    <td className="py-1 pr-3">{formatCount(s.weeklyActiveUsers)}</td>
                    <td className="py-1">{formatCount(s.totalUsers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </PlatformPanel>
  );
}

function ChartBlock({
  heading,
  note,
  samples,
  series,
}: {
  heading: string;
  note: string;
  samples: readonly PlatformMetricSample[];
  series: SeriesSpec[];
}) {
  const max = niceMax(
    Math.max(1, ...samples.flatMap((s) => series.map((sp) => s[sp.key]))),
  );
  const x = (i: number) =>
    samples.length === 1
      ? PAD_L
      : PAD_L + (i / (samples.length - 1)) * (VIEW_W - PAD_L - PAD_R);
  const y = (v: number) =>
    VIEW_H - PAD_B - (v / max) * (VIEW_H - PAD_T - PAD_B);

  const last = samples[samples.length - 1];

  return (
    <div>
      <div className="mb-1 text-sm font-medium text-neutral-800">{heading}</div>
      <p className="mb-2 text-[11px] leading-4 text-neutral-500">{note}</p>

      {/* 2개 이상이면 범례를 항상 둔다. 색만으로 식별하게 두지 않는다. */}
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-neutral-600">
          {series.map((sp) => (
            <span key={sp.key} className="inline-flex items-center gap-1">
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
          aria-label={`${heading} 시계열`}
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
                  {formatCount(Math.round(value))}
                </text>
              </g>
            );
          })}

          <text x={PAD_L} y={VIEW_H - 6} fontSize={9} fill="var(--axis-text)">
            {formatHour(samples[0].capturedAt)}
          </text>
          {samples.length > 1 && (
            <text
              x={VIEW_W - PAD_R}
              y={VIEW_H - 6}
              textAnchor="end"
              fontSize={9}
              fill="var(--axis-text)"
            >
              {formatHour(last.capturedAt)}
            </text>
          )}

          {series.map((sp) => (
            <g key={sp.key}>
              {pathSegments(samples, sp.key, x, y).map((d, i) => (
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
              {/* 점이 하나면 선이 안 보이므로 마커를 남긴다. */}
              {samples.length === 1 && (
                <circle
                  cx={x(0)}
                  cy={y(samples[0][sp.key])}
                  r={4}
                  fill={`var(${sp.varName})`}
                />
              )}
              {/* 직접 라벨. 대비가 낮은 슬롯의 relief이기도 하다. */}
              <text
                x={VIEW_W - PAD_R + 8}
                y={y(last[sp.key]) + 3}
                fontSize={10}
                fill="var(--axis-text)"
              >
                {sp.label} {formatCount(last[sp.key])}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
