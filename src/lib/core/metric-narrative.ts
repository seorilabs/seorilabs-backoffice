import { env } from "@/lib/env";
import { generateInsight } from "@/lib/insights/generate";
import { renderInsight, type Evidence } from "@/lib/insights/contract";
import { dbDay, metricDaysBetween } from "@/lib/analytics/metric-day";
import type {
  ConsoleListingSeries,
  Ga4AppGap,
  Ga4AppSeries,
  Movement,
  PortfolioTotals,
} from "@/lib/core/metric-highlights";

// 지표 하이라이트에 붙이는 한 문단 해설.
//
// 판정·순위·수치는 전부 결정적 코드가 낸다. LLM 은 **이미 계산된 결과만** 받아
// "왜 그럴 수 있는지, 무엇을 먼저 볼지"를 쓴다. 새 수치를 만들 재료를 주지 않으므로
// 환각이 리포트의 숫자를 오염시킬 수 없고, 실패하면 해설만 빠진다.

const MAX_MOVEMENTS = 8;
/** 수집 상태 줄에 이름을 적는 앱·리스팅 최대 수. 나머지는 건수로만 넘긴다. */
const MAX_NAMED_GAPS = 6;

/**
 * 수집 공백을 사람이 읽는 문장으로 만든다. 기준일 스냅샷이 없는 앱은 "지연"과
 * "수집 없음"을 구분한다 — 늦게 도착하는 것과 아예 안 들어오는 것은 다른 문제다.
 */
function ga4CoverageLines(
  refDate: string,
  onRefDateApps: number,
  gaps: readonly Ga4AppGap[],
): string[] {
  const total = onRefDateApps + gaps.length;
  const lines = [`GA4 기준일 스냅샷: ${total}개 앱 중 ${onRefDateApps}개 보유`];
  if (gaps.length === 0) return lines;
  const named = gaps.slice(0, MAX_NAMED_GAPS).map(({ app, latestDate }) => {
    const state = latestDate === null
      ? "수집 없음"
      : `${metricDaysBetween(refDate, dbDay(latestDate))}일 지연`;
    return `${app.displayName}(${app.type}, ${state})`;
  });
  lines.push(
    `기준일 스냅샷이 없는 앱 ${gaps.length}개: ${named.join(", ")}` +
      (gaps.length > named.length ? ` 외 ${gaps.length - named.length}개` : ""),
  );
  return lines;
}

/** 콘솔은 cron 이 아니라 온디맨드 push 라 리스팅마다 기준일이 다르다. */
function consoleCoverageLines(
  refDate: string,
  series: readonly ConsoleListingSeries[],
  missing: readonly string[],
): string[] {
  const listings = series.length + missing.length;
  if (series.length === 0) {
    return [`콘솔 스냅샷: ${listings}개 리스팅 모두 수집 없음`];
  }
  const latestMs = Math.max(...series.map((one) => one.rowsDesc[0].date.getTime()));
  const consoleRefDate = dbDay(new Date(latestMs));
  const onRef = series.filter((one) => dbDay(one.rowsDesc[0].date) === consoleRefDate).length;
  const lines = [
    `콘솔 최신 스냅샷 기준일 ${consoleRefDate}` +
      ` · 보고서 기준일과 ${metricDaysBetween(refDate, dbDay(new Date(latestMs)))}일 차이` +
      ` · 그 기준일 스냅샷 보유 ${onRef}/${listings}개 리스팅`,
  ];
  if (missing.length > 0) {
    const named = missing.slice(0, MAX_NAMED_GAPS);
    lines.push(
      `콘솔 수집이 한 번도 없는 리스팅 ${missing.length}개: ${named.join(", ")}` +
        (missing.length > named.length ? ` 외 ${missing.length - named.length}개` : ""),
    );
  }
  return lines;
}

export interface NarrativeInput {
  refDate: string;
  totals: PortfolioTotals;
  movements: readonly Movement[];
  /** 주면 수집 공백(지연·미수집)을 사실에 함께 넘긴다. */
  ga4Series?: readonly Ga4AppSeries[];
  ga4Gaps?: readonly Ga4AppGap[];
  consoleSeries?: readonly ConsoleListingSeries[];
  consoleMissing?: readonly string[];
}

/** 해설이 참고할 수 있는 사실만 담은 요약. 원본 스냅샷은 넘기지 않는다. */
export function narrativeFacts(input: NarrativeInput): string {
  const lines = [
    `기준일: ${input.refDate} (D-1)`,
    `GA4 DAU 합계 ${input.totals.ga4Dau.latest}명 (전일 ${input.totals.ga4Dau.previous ?? "미상"}) · 대상 ${input.totals.ga4Dau.apps}개 앱`,
    `콘솔 광고 수익 ${Math.round(input.totals.console.iaaKrw)}원 · 결제 ${Math.round(input.totals.console.iapKrw)}원 · 대상 ${input.totals.console.listings}개 리스팅`,
  ];
  if (input.ga4Series) {
    lines.push(
      "",
      "수집 상태:",
      ...ga4CoverageLines(input.refDate, input.ga4Series.length, input.ga4Gaps ?? []),
    );
    if (input.consoleSeries) {
      lines.push(
        ...consoleCoverageLines(input.refDate, input.consoleSeries, input.consoleMissing ?? []),
      );
    }
  }
  const judged = input.movements.filter(
    (m) => m.verdict === "highlight" || m.verdict === "lowlight",
  );
  if (judged.length === 0) {
    lines.push("임계를 넘은 변동 없음");
    return lines.join("\n");
  }
  lines.push("", "임계를 넘은 변동:");
  for (const m of judged.slice(0, MAX_MOVEMENTS)) {
    const delta = m.change == null
      ? "신규"
      : m.spec.pointScale
        ? `${m.change >= 0 ? "+" : ""}${m.change.toFixed(1)}%p`
        : `${m.change >= 0 ? "+" : ""}${Math.round(m.change)}%`;
    lines.push(
      `- ${m.label} · ${m.spec.source} ${m.spec.ko}: ${m.spec.format(m.latest)}` +
        (m.baseline == null ? "" : ` (기준 ${m.spec.format(m.baseline)})`) +
        ` ${delta} · ${m.verdict === "highlight" ? "상승" : "하락"}`,
    );
  }
  const flat = input.movements.filter((m) => m.verdict === "flat").length;
  const insufficient = input.movements.filter((m) => m.verdict === "insufficient").length;
  lines.push("", `판정에서 제외: 변동 없음 ${flat}건 · 표본 부족 ${insufficient}건`);
  return lines.join("\n");
}

export const NARRATIVE_PROMPT_VERSION = 2;

export function narrativeEvidence(input: NarrativeInput): Evidence[] {
  const facts: Evidence[] = [
    { id: "active", label: "앱별 활성 합계", value: `${input.totals.ga4Dau.latest}명 - 중복 사용자 포함`, source: `GA4 ${input.refDate}` },
    { id: "coverage", label: "기준일 자료", value: `${input.totals.ga4Dau.apps}개 앱 수집 · ${(input.ga4Gaps ?? []).length}개 미도착`, source: `MetricCollectionLedger ${input.refDate}` },
  ];
  for (const [index, m] of input.movements.filter((m) => m.verdict === "highlight" || m.verdict === "lowlight").slice(0, 5).entries()) facts.push({
    id: `movement_${index}`, label: `${m.label} ${m.spec.ko}`.slice(0, 100), value: `${m.spec.format(m.latest)} · 기준 ${m.baseline == null ? "표본 부족" : m.spec.format(m.baseline)}`, source: `${m.spec.source} ${input.refDate}`,
  });
  return facts;
}
export function narrativeSkeleton(input: NarrativeInput): string {
  const facts = narrativeEvidence(input);
  return renderInsight({ bullets: [
    { kind: "fact", text: "{active} 관측됨", evidenceIds: ["active"] },
    { kind: "fact", text: "{coverage} 확인됨", evidenceIds: ["coverage"] },
    { kind: "action", text: (input.ga4Gaps?.length ?? 0) > 0 ? "수집 상태를 먼저 확인 필요" : "앱별 변동과 획득 경로 비교 필요", evidenceIds: ["coverage"] },
  ] }, facts);
}
export interface MetricNarrative { text: string; fallback: boolean; provider: string | null; model: string | null; promptVersion: number; }
export async function metricNarrative(input: NarrativeInput): Promise<MetricNarrative> {
  const made = await generateInsight(narrativeEvidence(input), "growth");
  return { text: made.fallback ? narrativeSkeleton(input) : renderInsight(made.content, narrativeEvidence(input)), fallback: made.fallback, provider: made.fallback ? null : "minimax", model: made.fallback ? null : env.minimaxChatModel(), promptVersion: NARRATIVE_PROMPT_VERSION };
}
