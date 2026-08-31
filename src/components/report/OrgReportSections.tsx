import React from "react";
import { METRIC_SPECS, type MetricSpec } from "@/lib/core/metric-highlights";
import type { MovementSnapshot, OrgReportDocument } from "@/lib/core/org-report-schema";
import type { OrgReportView } from "@/lib/core/org-report";

// Org 종합 보고서의 프레젠테이션(순수 서버 컴포넌트). 데이터 로딩·날짜 검증은 페이지가
// 하고, 여기는 문서(OrgReportDocument)를 그대로 그린다. 발행 스냅샷과 재계산 문서가
// 같은 컴포넌트를 지나므로 두 경로의 화면이 어긋날 수 없다.

const SPEC_BY_KEY = new Map<string, MetricSpec>(METRIC_SPECS.map((spec) => [spec.key, spec]));

const count = (value: number): string => Math.round(value).toLocaleString("ko-KR");
const won = (value: number): string => `₩${count(value)}`;
const usd = (value: number): string => `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}`;

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-neutral-700">{title}</div>
      {children}
    </div>
  );
}

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      {children}
    </div>
  );
}

/** 이 화면이 발행문인지 재계산인지. 재계산 값은 GA4 재집계로 발행 당시와 다를 수 있다. */
export function SourceBadge({ view }: { view: OrgReportView }) {
  if (view.source === "snapshot") {
    const time = view.generatedAt
      ? new Intl.DateTimeFormat("ko-KR", {
          timeZone: "Asia/Seoul",
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(view.generatedAt)
      : null;
    const retro = view.doc.origin === "recomputed";
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
          retro ? "bg-sky-100 text-sky-800" : "bg-emerald-100 text-emerald-800"
        }`}
        title={
          retro
            ? "발행 당시가 아니라 나중에 원본에서 소급 계산해 저장한 스냅샷입니다."
            : "매일 11:00 KST 발행 시점의 문서를 그대로 보여줍니다."
        }
      >
        {retro ? "소급 발행" : "발행 스냅샷"}
        {time && <span className="font-normal opacity-80">{time}</span>}
        {view.version != null && view.version > 1 && (
          <span className="font-normal opacity-80">v{view.version}</span>
        )}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800"
      title="이 날짜의 발행 스냅샷이 없어 현재 저장된 원본 지표로 재계산했습니다. GA4 재집계로 발행 당시와 다를 수 있고, 비용·해설은 복원되지 않습니다."
    >
      재계산
    </span>
  );
}

// ── 요약 카드 ────────────────────────────────────────────────────────────────

function DeltaTag({ current, previous }: { current: number; previous: number | null }) {
  // 전일 값이 없으면 변화율을 지어내지 않는다.
  if (previous == null || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const cls = pct > 0 ? "text-emerald-600" : pct < 0 ? "text-red-600" : "text-neutral-400";
  return (
    <span className={`ml-1.5 text-xs font-medium ${cls}`}>
      {pct >= 0 ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  delta,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-neutral-900">
        {value}
        {delta}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-neutral-400">{sub}</div>}
    </div>
  );
}

export function SummaryCards({ doc }: { doc: OrgReportDocument }) {
  const { ga4, console: consoleSummary } = doc.summary;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <SummaryCard
        label="GA4 DAU"
        value={`${count(ga4.dau)}명`}
        sub={`대상 ${ga4.apps}개 앱`}
        delta={<DeltaTag current={ga4.dau} previous={ga4.dauPrev} />}
      />
      <SummaryCard label="신규 사용자" value={`${count(ga4.newUsers)}명`} sub="first_visit" />
      <SummaryCard label="활성 사용자" value={`${count(ga4.engagedUsers)}명`} sub="engaged" />
      <SummaryCard label="보상형 광고 완료" value={`${count(ga4.adCompletions)}회`} />
      <SummaryCard
        label="콘솔 광고 수익"
        value={won(consoleSummary.iaaKrw)}
        sub={`대상 ${consoleSummary.listings}개 리스팅`}
        delta={<DeltaTag current={consoleSummary.iaaKrw} previous={consoleSummary.iaaPrevKrw} />}
      />
      <SummaryCard
        label="결제 거래액"
        value={won(consoleSummary.iapTrxKrw)}
        sub={
          consoleSummary.payingUsers > 0
            ? `결제자 ${count(consoleSummary.payingUsers)}명 · 정산 ${won(consoleSummary.iapSettlementKrw)}`
            : undefined
        }
      />
    </div>
  );
}

// ── 하이라이트·로우라이트 ────────────────────────────────────────────────────

function movementDelta(movement: MovementSnapshot, spec: MetricSpec): string {
  if (movement.change == null) return "신규";
  return spec.pointScale
    ? `${movement.change >= 0 ? "+" : ""}${movement.change.toFixed(1)}%p`
    : `${movement.change >= 0 ? "+" : ""}${Math.round(movement.change)}%`;
}

function MovementList({
  movements,
  refDate,
  tone,
}: {
  movements: MovementSnapshot[];
  refDate: string;
  tone: "highlight" | "lowlight";
}) {
  const cls = tone === "highlight" ? "text-emerald-600" : "text-red-600";
  return (
    <ol className="space-y-1.5 text-sm">
      {movements.map((movement, index) => {
        const spec = SPEC_BY_KEY.get(movement.metricKey);
        if (!spec) return null;
        return (
          <li key={`${movement.label}:${movement.metricKey}`} className="flex items-baseline gap-2">
            <span className="w-4 shrink-0 text-right text-xs text-neutral-400">{index + 1}.</span>
            <span>
              <b className="text-neutral-800">{movement.label}</b>
              <span className="text-neutral-500">
                {" "}
                · {spec.source} {spec.ko} {spec.format(movement.latest)}
              </span>
              {movement.baseline != null && (
                <span className="text-neutral-400"> (기준 {spec.format(movement.baseline)})</span>
              )}
              <span className={`ml-1 font-medium ${cls}`}>{movementDelta(movement, spec)}</span>
              {movement.date !== refDate && (
                <span className="ml-1 text-xs text-amber-600" title="이 값의 기준일이 보고서 기준일과 다릅니다.">
                  ⏳{movement.date}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function HighlightSection({ doc }: { doc: OrgReportDocument }) {
  const ranked = (verdict: "highlight" | "lowlight") =>
    doc.movements
      .filter((movement) => movement.verdict === verdict)
      .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, "ko"));
  const highlights = ranked("highlight");
  const lowlights = ranked("lowlight");
  const tally = (verdict: MovementSnapshot["verdict"]) =>
    doc.movements.filter((movement) => movement.verdict === verdict).length;
  const absent = tally("absent");

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Panel title="🟢 하이라이트">
        {highlights.length > 0 ? (
          <MovementList movements={highlights} refDate={doc.refDate} tone="highlight" />
        ) : (
          <div className="text-sm text-neutral-400">임계를 넘은 상승 없음</div>
        )}
      </Panel>
      <Panel title="🔴 로우라이트">
        {lowlights.length > 0 ? (
          <MovementList movements={lowlights} refDate={doc.refDate} tone="lowlight" />
        ) : (
          <div className="text-sm text-neutral-400">임계를 넘은 하락 없음</div>
        )}
      </Panel>
      <div className="text-xs text-neutral-400 lg:col-span-2">
        판정 {doc.movements.length - absent}건 (변동 없음 {tally("flat")} · 표본 부족 {tally("insufficient")}) ·
        미집계 {absent}건 — 판정 기준: 직전 7일 중앙값 대비 절대·상대 임계 동시 초과
      </div>
    </div>
  );
}

export function NarrativeBlock({ narrative }: { narrative: string | null }) {
  if (!narrative) return null;
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 text-sm leading-6 text-neutral-700">
      🧠 {narrative}
    </div>
  );
}

// ── 앱별 분해 ────────────────────────────────────────────────────────────────

function deltaCell(current: number, base: number | null): React.ReactNode {
  if (base == null || base === 0) return <span className="text-neutral-300">—</span>;
  const pct = ((current - base) / base) * 100;
  const cls = pct > 0 ? "text-emerald-600" : pct < 0 ? "text-red-600" : "text-neutral-400";
  return (
    <span className={cls}>
      {pct >= 0 ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

export function AppBreakdownTable({ doc }: { doc: OrgReportDocument }) {
  if (doc.apps.length === 0) {
    return <div className="text-sm text-neutral-400">기준일 데이터가 있는 앱이 없습니다.</div>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full min-w-[920px] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">앱</th>
            <th className="px-3 py-2">유형</th>
            <th className="px-3 py-2 text-right">DAU</th>
            <th className="px-3 py-2 text-right">전일比</th>
            <th className="px-3 py-2 text-right">7일比</th>
            <th className="px-3 py-2 text-right">신규</th>
            <th className="px-3 py-2 text-right">D1</th>
            <th className="px-3 py-2 text-right">광고 완료</th>
            <th className="px-3 py-2 text-right">토스 DAU</th>
            <th className="px-3 py-2 text-right">광고 수익</th>
            <th className="px-3 py-2 text-right">결제</th>
          </tr>
        </thead>
        <tbody>
          {doc.apps.map((app) => {
            const listingSum = (pick: (l: (typeof app.listings)[number]) => number) =>
              app.listings.reduce((sum, listing) => sum + pick(listing), 0);
            const consoleDauRows = app.listings.filter((listing) => listing.dau != null);
            const maxLag = Math.max(0, ...app.listings.map((listing) => listing.lagDays));
            const lagTitle = app.listings
              .map((listing) => `${listing.label ?? "기본"} ${listing.date}`)
              .join(" · ");
            return (
              <tr key={app.slug} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                <td className="px-3 py-1.5 text-neutral-800">{app.displayName}</td>
                <td className="px-3 py-1.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                      app.type === "GAME" ? "bg-violet-100 text-violet-700" : "bg-sky-100 text-sky-700"
                    }`}
                  >
                    {app.type === "GAME" ? "게임" : "앱"}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {app.ga4 ? count(app.ga4.dau) : <span className="text-neutral-300">—</span>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {app.ga4 ? deltaCell(app.ga4.dau, app.ga4.dauPrev) : <span className="text-neutral-300">—</span>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {app.ga4 ? (
                    deltaCell(app.ga4.dau, app.ga4.dau7dMedian)
                  ) : (
                    <span className="text-neutral-300">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600">
                  {app.ga4 ? count(app.ga4.newUsers) : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600">
                  {app.ga4?.d1Pct != null ? `${app.ga4.d1Pct}%` : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600">
                  {app.ga4 ? count(app.ga4.adCompletions) : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600">
                  {app.listings.length === 0 ? (
                    "—"
                  ) : (
                    <span title={lagTitle}>
                      {consoleDauRows.length
                        ? count(consoleDauRows.reduce((sum, listing) => sum + (listing.dau ?? 0), 0))
                        : "—"}
                      {maxLag > 0 && <span className="ml-1 text-xs text-amber-600">⏳{maxLag}일</span>}
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600">
                  {app.listings.length ? won(listingSum((listing) => listing.iaaKrw)) : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600">
                  {app.listings.length ? won(listingSum((listing) => listing.iapTrxKrw)) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── 분해(플랫폼/게임·비게임/유입경로) ────────────────────────────────────────

export interface SplitItem {
  label: string;
  value: number;
  cls: string;
}

/** 비중 막대 + 범례. 플랫폼/게임·비게임 공용(PlatformSplit 과 같은 방식). */
export function SplitBar({ items, empty }: { items: SplitItem[]; empty?: string }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) {
    return <div className="text-sm text-neutral-400">{empty ?? "데이터 없음"}</div>;
  }
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-neutral-100">
        {items
          .filter((item) => item.value > 0)
          .map((item) => (
            <div
              key={item.label}
              className={item.cls}
              style={{ width: `${(item.value / total) * 100}%` }}
              title={`${item.label} ${count(item.value)}`}
            />
          ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600">
        {items.map((item) => (
          <span key={item.label} className="inline-flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${item.cls}`} />
            {item.label} <b className="text-neutral-800">{count(item.value)}</b>
            <span className="text-neutral-400">({Math.round((item.value / total) * 100)}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 콘솔 유입경로 비중(리스팅 유입 수 합산 기준). */
export function ReferrerList({ referrers }: { referrers: OrgReportDocument["referrers"] }) {
  if (referrers.length === 0) {
    return <div className="text-sm text-neutral-400">유입경로 데이터 없음</div>;
  }
  const max = Math.max(...referrers.map((item) => item.rate), 0.01);
  return (
    <div className="space-y-1.5">
      {referrers.slice(0, 6).map((item) => (
        <div key={item.dimension} className="flex items-center gap-2 text-sm">
          <span className="w-24 shrink-0 truncate text-neutral-700" title={item.dimension}>
            {item.dimension}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-100">
            <div
              className="h-full rounded-full bg-sky-400"
              style={{ width: `${(item.rate / max) * 100}%` }}
            />
          </div>
          <span className="w-12 shrink-0 text-right tabular-nums text-neutral-600">
            {Math.round(item.rate * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}

// ── 수익 vs 비용 ─────────────────────────────────────────────────────────────

export function RevenueCostSection({ doc }: { doc: OrgReportDocument }) {
  const revenue = doc.summary.console;
  const costs = doc.costs;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <SummaryCard label="광고 수익 (기준일)" value={won(revenue.iaaKrw)} />
        <SummaryCard label="결제 거래액 (기준일)" value={won(revenue.iapTrxKrw)} />
        {costs?.figures.github && (
          <SummaryCard
            label="GitHub Actions (월누적)"
            value={usd(costs.figures.github.netUsd)}
            sub={`환산 ${count(costs.figures.github.quotaMinutes)}분/${count(costs.figures.github.includedMinutes)}분`}
          />
        )}
        {costs?.figures.gcp && (
          <SummaryCard
            label="GCP 순비용 (월누적)"
            value={
              costs.figures.gcp.currency === "KRW"
                ? won(costs.figures.gcp.total)
                : `${costs.figures.gcp.total} ${costs.figures.gcp.currency}`
            }
          />
        )}
        {costs?.figures.llm && (
          <SummaryCard label="LLM (월누적)" value={usd(costs.figures.llm.totalUsd)} />
        )}
        {costs?.figures.stability && (
          <SummaryCard label="Stability 크레딧 잔액" value={count(costs.figures.stability.credits)} />
        )}
      </div>
      {/* 수익은 기준일 하루치, 비용은 이번 달 누적(MTD)이다 — 단위가 달라 순익을 계산하지 않는다. */}
      {costs ? (
        <>
          <p className="text-xs text-neutral-400">
            수익은 기준일 하루치, 비용은 발행 시점의 이번 달({costs.month}) 누적입니다.
          </p>
          {costs.warnings.length > 0 && (
            <div className="space-y-2">
              {costs.warnings.map((warning) => (
                <div
                  key={warning.key}
                  className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
                >
                  <div className="font-medium">⚠️ {warning.title}</div>
                  <div className="mt-0.5 text-xs">{warning.detail}</div>
                  {warning.evidence.map((evidence) => (
                    <div key={evidence} className="mt-0.5 text-xs opacity-80">
                      - {evidence}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <details className="text-xs text-neutral-500">
            <summary className="cursor-pointer">발행 시점 비용 상세</summary>
            <pre className="mt-2 whitespace-pre-wrap rounded bg-neutral-50 p-3 text-[11px] leading-5">
              {costs.summaryLines.join("\n")}
            </pre>
          </details>
        </>
      ) : (
        <p className="text-xs text-neutral-400">
          비용은 발행 시점에만 수집됩니다 — 이 문서는 재계산이라 발행 당시 비용이 보존되지 않았습니다.
        </p>
      )}
    </div>
  );
}
