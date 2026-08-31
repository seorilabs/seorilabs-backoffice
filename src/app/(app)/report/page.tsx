import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { isoDate, latestClosedDay } from "@/lib/ga4/datasets";
import { getOrgReport, orgTrendSeries, type OrgTrendPoint } from "@/lib/core/org-report";
import { clampReportDate, parseReportDate } from "@/lib/report/params";
import { ReportDatePicker } from "@/components/report/ReportDatePicker";
import { ReportLineChart } from "@/components/report/ReportLineChart";
import {
  AppBreakdownTable,
  HighlightSection,
  NarrativeBlock,
  Notice,
  Panel,
  ReferrerList,
  RevenueCostSection,
  SourceBadge,
  SplitBar,
  SummaryCards,
} from "@/components/report/OrgReportSections";

// Org 종합 지표 보고서. 날짜 하나의 발행 스냅샷(없으면 재계산)을 다각도로 펼치고,
// 선택일을 끝점으로 하는 추이는 항상 원본 시계열에서 그린다.

export const dynamic = "force-dynamic";

const TREND_DAYS = 28;

function maxOf(values: ReadonlyArray<number | null>): number {
  return Math.max(0, ...values.filter((value): value is number => value != null));
}

function TrendCharts({ trend }: { trend: OrgTrendPoint[] }) {
  const dates = trend.map((point) => point.date);
  const dau = trend.map((point) => point.ga4Dau);
  const newUsers = trend.map((point) => point.ga4NewUsers);
  // 자릿수가 크게 다르면 작은 계열이 바닥에 눌린다 — 차트를 나눈다(이중 y축 금지).
  const splitActivity = maxOf(dau) >= 10 * Math.max(1, maxOf(newUsers));
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {splitActivity ? (
        <>
          <ReportLineChart
            title={`GA4 DAU 추이 (${TREND_DAYS}일)`}
            note="전 앱 합산 · 원본 일별 스냅샷 기준(수집 없는 날은 선을 끊음)"
            dates={dates}
            series={[{ label: "DAU", varName: "--series-1", values: dau }]}
          />
          <ReportLineChart
            title={`신규 사용자 추이 (${TREND_DAYS}일)`}
            note="전 앱 합산 first_visit"
            dates={dates}
            series={[{ label: "신규", varName: "--series-2", values: newUsers }]}
          />
        </>
      ) : (
        <ReportLineChart
          title={`GA4 활성 추이 (${TREND_DAYS}일)`}
          note="전 앱 합산 · 원본 일별 스냅샷 기준(수집 없는 날은 선을 끊음)"
          dates={dates}
          series={[
            { label: "DAU", varName: "--series-1", values: dau },
            { label: "신규", varName: "--series-2", values: newUsers },
          ]}
        />
      )}
      <ReportLineChart
        title={`콘솔 수익 추이 (${TREND_DAYS}일)`}
        note="AppsInToss 콘솔 · 광고 추정수익 + 결제 거래액(원)"
        dates={dates}
        format="krw"
        series={[
          { label: "광고", varName: "--series-1", values: trend.map((point) => point.consoleIaaKrw) },
          { label: "결제", varName: "--series-2", values: trend.map((point) => point.consoleIapTrxKrw) },
        ]}
      />
    </div>
  );
}

export default async function OrgReportPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const sp = await searchParams;
  const now = new Date();

  // 날짜 피커의 min/max 는 원본 데이터가 실제 존재하는 범위다(D-1 상한).
  const [ga4Range, consoleRange] = await Promise.all([
    prisma.appMetricDaily.aggregate({
      where: { app: visibleAppWhere },
      _min: { date: true },
      _max: { date: true },
    }),
    prisma.appConsoleMetricDaily.aggregate({
      where: { app: visibleAppWhere },
      _min: { date: true },
      _max: { date: true },
    }),
  ]);
  const mins = [ga4Range._min.date, consoleRange._min.date].filter((d): d is Date => d != null);
  const maxes = [ga4Range._max.date, consoleRange._max.date].filter((d): d is Date => d != null);

  const header = (
    <>
      <h1 className="text-xl font-semibold">Org 종합 지표 보고서</h1>
      <p className="mt-1 text-sm text-neutral-500">
        전 앱 합산 일일 보고서 · 매일 11:00 KST 발행 스냅샷 보존 · 기준일 D-1(전일 확정)
      </p>
    </>
  );

  if (mins.length === 0 || maxes.length === 0) {
    return (
      <div className="px-4 py-6 sm:p-8">
        {header}
        <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
          아직 수집된 지표가 없습니다. GA4 수집(10:00 KST)과 콘솔 push 이후 채워집니다.
        </div>
      </div>
    );
  }

  const minDate = isoDate(new Date(Math.min(...mins.map((d) => d.getTime()))));
  const dataMax = isoDate(new Date(Math.max(...maxes.map((d) => d.getTime()))));
  const cap = isoDate(latestClosedDay(now));
  const maxDate = dataMax < cap ? dataMax : cap;

  const requested = parseReportDate(sp.date);
  const { date: selected, clamped } = clampReportDate(requested ?? maxDate, minDate, maxDate);

  const [view, trend] = await Promise.all([
    getOrgReport(selected, now),
    orgTrendSeries(selected, TREND_DAYS),
  ]);

  return (
    <div className="px-4 py-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>{header}</div>
        <ReportDatePicker selected={selected} min={minDate} max={maxDate} />
      </div>

      <div className="mt-4 space-y-4">
        {requested != null && clamped && (
          <Notice>
            {requested} 은(는) 데이터 범위({minDate} ~ {maxDate}) 밖이라 {selected} 을(를)
            표시합니다.
          </Notice>
        )}

        {view == null ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
            {selected} 에는 수집된 GA4·콘솔 데이터가 없습니다. 다른 날짜를 선택하세요.
          </div>
        ) : (
          <>
            {/* 기준일·출처 — 콘솔은 온디맨드 push 라 GA4 와 기준일이 다를 수 있다. */}
            <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-600">
              <span className="text-lg font-semibold text-neutral-900">{view.doc.refDate}</span>
              <SourceBadge view={view} />
              <span className="text-xs text-neutral-400">
                GA4 기준 {view.doc.refDate} · 콘솔 기준{" "}
                {view.doc.consoleMeta.refDate ?? "수집 없음"}
                {view.doc.consoleMeta.lagDays != null && view.doc.consoleMeta.lagDays > 0 && (
                  <span className="text-amber-600"> ({view.doc.consoleMeta.lagDays}일 지연)</span>
                )}
              </span>
            </div>
            {view.doc.consoleMeta.missing.length > 0 && (
              <p className="text-xs text-neutral-400">
                콘솔 수집 없음: {view.doc.consoleMeta.missing.join(", ")}
              </p>
            )}

            <SummaryCards doc={view.doc} />
            <HighlightSection doc={view.doc} />
            <NarrativeBlock narrative={view.doc.narrative} />
            <TrendCharts trend={trend} />

            <Panel title="앱별 분해">
              <AppBreakdownTable doc={view.doc} />
            </Panel>

            <div className="grid gap-3 lg:grid-cols-3">
              <Panel title="플랫폼 분해 (GA4 DAU)">
                <SplitBar
                  items={[
                    { label: "Android", value: view.doc.platform.android.dau, cls: "bg-emerald-500" },
                    { label: "iOS", value: view.doc.platform.ios.dau, cls: "bg-sky-500" },
                    { label: "Web", value: view.doc.platform.web.dau, cls: "bg-violet-500" },
                  ]}
                  empty="플랫폼 데이터 없음"
                />
              </Panel>
              <Panel title="게임 / 비게임 (GA4 DAU)">
                <SplitBar
                  items={[
                    { label: "게임", value: view.doc.segments.game.dau, cls: "bg-violet-500" },
                    { label: "앱", value: view.doc.segments.app.dau, cls: "bg-sky-500" },
                  ]}
                  empty="분해할 데이터 없음"
                />
                <p className="mt-2 text-xs text-neutral-400">
                  광고 수익 — 게임 {`₩${Math.round(view.doc.segments.game.iaaKrw).toLocaleString("ko-KR")}`} ·
                  앱 {`₩${Math.round(view.doc.segments.app.iaaKrw).toLocaleString("ko-KR")}`}
                </p>
              </Panel>
              <Panel title="콘솔 유입경로">
                <ReferrerList referrers={view.doc.referrers} />
              </Panel>
            </div>

            <Panel title="수익 vs 비용">
              <RevenueCostSection doc={view.doc} />
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
