import React from "react";
import { dbDay } from "@/lib/analytics/metric-day";

export interface ConsoleRevenueAgg {
  observedDays: number;
  impressions: number;
  earningKrw: number;
}

export interface ConsoleMonthlyRevenueItem {
  key: string;
  appName: string;
  listingLabel: string;
  miniAppId: number;
  current: ConsoleRevenueAgg;
  previousComparable: ConsoleRevenueAgg;
  previousFull: ConsoleRevenueAgg;
  changePct: number | null;
}

export interface ConsoleMonthlyRevenueReport {
  reportDate: Date;
  currentLabel: string;
  previousLabel: string;
  currentElapsedDays: number;
  previousComparableDays: number;
  previousCalendarDays: number;
  targetListings: number;
  items: ConsoleMonthlyRevenueItem[];
  currentTotal: ConsoleRevenueAgg;
  previousComparableTotal: ConsoleRevenueAgg;
  previousFullTotal: ConsoleRevenueAgg;
  changePct: number | null;
}

const revenueWon = (value: ConsoleRevenueAgg): string =>
  value.observedDays > 0 ? `₩${Math.round(value.earningKrw).toLocaleString("ko-KR")}` : "미수집";
const revenueChange = (value: number | null): string =>
  value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

function RevenueSummaryCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-neutral-900">{value}</div>
      <div className="mt-1 text-xs text-neutral-400">{note}</div>
    </div>
  );
}

export function ConsoleMonthlyRevenue({ report }: { report: ConsoleMonthlyRevenueReport }) {
  const currentExpected = report.targetListings * report.currentElapsedDays;
  const previousFullExpected = report.targetListings * report.previousCalendarDays;
  const changeAvailable = report.changePct != null;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-neutral-700">
            AppsInToss 콘솔 · 월 누적 예상 광고수익
          </div>
          <div className="mt-0.5 text-xs text-neutral-400">
            기준일 {dbDay(report.reportDate)} · AppsInToss estimatedEarning · 정산 확정액 아님
          </div>
        </div>
        <div className="text-xs text-neutral-400">
          서로 다른 리스팅의 합계는 리스팅 보고 수익 합계로 표시
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <RevenueSummaryCard
          label={`${report.currentLabel} 누적`}
          value={revenueWon(report.currentTotal)}
          note={`1~${report.currentElapsedDays}일 · 리스팅 보고 수익 합계`}
        />
        <RevenueSummaryCard
          label={`${report.previousLabel} 동기간`}
          value={revenueWon(report.previousComparableTotal)}
          note={`1~${report.previousComparableDays}일 관측 합계`}
        />
        <RevenueSummaryCard
          label="전월 동기간 대비"
          value={revenueChange(report.changePct)}
          note={changeAvailable ? "양쪽 동기간 완전 관측" : "누락 또는 기준 0원으로 비교 보류"}
        />
        <RevenueSummaryCard
          label="이번 달 수집 범위"
          value={`${report.currentTotal.observedDays}/${currentExpected} 리스팅-일`}
          note={`지난달 전체 ${report.previousFullTotal.observedDays}/${previousFullExpected} 리스팅-일`}
        />
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
              <th className="px-3 py-2">앱 / 리스팅</th>
              <th className="px-3 py-2 text-right">이번 달 수집</th>
              <th className="px-3 py-2 text-right">광고노출</th>
              <th className="px-3 py-2 text-right">이번 달 예상수익</th>
              <th className="px-3 py-2 text-right">전월 동기간</th>
              <th className="px-3 py-2 text-right">동기간 대비</th>
              <th className="px-3 py-2 text-right">전월 전체 관측 합계</th>
            </tr>
          </thead>
          <tbody>
            {report.items.map((item) => (
              <tr key={item.key} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                <td className="px-3 py-2">
                  <div className="font-medium text-neutral-800">{item.appName}</div>
                  <div className="text-xs text-neutral-400">
                    {item.listingLabel} · #{item.miniAppId}
                  </div>
                </td>
                <td className="px-3 py-2 text-right text-neutral-600">
                  {item.current.observedDays}/{report.currentElapsedDays}일
                </td>
                <td className="px-3 py-2 text-right text-neutral-600">
                  {item.current.observedDays > 0 ? item.current.impressions.toLocaleString("ko-KR") : "미수집"}
                </td>
                <td className="px-3 py-2 text-right font-medium">
                  {revenueWon(item.current)}
                </td>
                <td className="px-3 py-2 text-right text-neutral-600">
                  {revenueWon(item.previousComparable)}
                </td>
                <td className="px-3 py-2 text-right text-neutral-600">
                  {revenueChange(item.changePct)}
                </td>
                <td className="px-3 py-2 text-right text-neutral-600">
                  {revenueWon(item.previousFull)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-xs text-neutral-400">
        전월 동기간 대비는 해당 리스팅의 양쪽 기간이 모두 수집되고 전월 수익이 0원보다 클 때만
        표시합니다. 누락된 날짜는 0원으로 간주하지 않습니다.
      </div>
    </div>
  );
}

