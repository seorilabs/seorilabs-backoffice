import { env } from "@/lib/env";
import { llmChat, llmChatConfigured, llmChatModel } from "@/lib/ai/llm";
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

const SYSTEM_PROMPT = [
  "당신은 Seorilabs 앱 제작 공장의 지표 분석가다.",
  "아래는 이미 계산이 끝난 어제 지표 변동과 수집 상태다. 이 사실만으로 해설을 쓴다.",
  "",
  "규칙:",
  "- 주어진 사실에 없는 수치를 새로 만들거나 계산하지 않는다. 숫자를 인용할 때는 그대로 옮긴다.",
  "- 원인을 단정하지 않는다. 가능성은 '~일 수 있다'로 쓰고, 확인 방법을 함께 적는다.",
  "- 같은 앱이 여러 소스에서 같은 방향으로 움직였으면 그 일치를 짚는다. 표면 이동이 아니라 실제 변화라는 신호다.",
  "- 표본 부족·변동 없음 건수가 많다고 해서 문제라고 말하지 않는다. 규모가 작으면 정상이다.",
  "- 수집 공백은 지표 하락과 구분한다. 기준일 스냅샷이 없는 앱의 수치는 '떨어진 것'이 아니라",
  "  '아직 모르는 것'이다. 합계가 전일보다 낮을 때 그 앱들이 빠져서인지 먼저 따진다.",
  "- '지연'과 '수집 없음'을 섞지 않는다. 지연은 기다리면 채워지고, 수집 없음은 배선을 봐야 한다.",
  "",
  "형식: 한국어로 아래 세 줄 머리말을 그대로 쓰고 각 항목 아래에 문장을 붙인다.",
  "전체 800~1200자. 목록 기호·인사말·마무리 인사는 쓰지 않는다.",
  "",
  "핵심 변동:",
  "(임계를 넘은 변동 중 규모가 큰 것부터. 없으면 없다고 한 문장.)",
  "GA4·콘솔 짚을 점:",
  "(수집 상태에서 읽히는 것. 지연·미수집이 합계를 어떻게 왜곡하는지.)",
  "다음 액션:",
  "(무엇을 먼저 확인할지. 확인 대상과 방법을 구체적으로.)",
].join("\n");

/** 해설이 반드시 갖춰야 하는 세 절. 하나라도 없으면 형식이 깨진 것이다. */
export const NARRATIVE_SECTIONS = ["핵심 변동:", "GA4·콘솔 짚을 점:", "다음 액션:"] as const;

/**
 * 프롬프트 개정 번호. 문서에 기록해 "이 해설이 어떤 지시로 쓰였는지"를 나중에 안다.
 * 지시를 바꿀 때마다 올린다.
 */
export const NARRATIVE_PROMPT_VERSION = 1;

/**
 * 결정적 골격. LLM 없이도 보고서가 성립해야 한다.
 *
 * 지금까지는 LLM 미설정·실패·형식 이탈이면 해설이 통째로 빠졌다. 읽는 사람에게는
 * "어떤 날은 분석이 있고 어떤 날은 없다"로 보였고, 그것 자체가 보고서를 못 믿게 만든다.
 * 수치와 판정과 수집 상태는 전부 코드가 이미 알고 있으므로 문장으로 옮기면 된다.
 */
export function narrativeSkeleton(input: NarrativeInput): string {
  const judged = input.movements.filter(
    (one) => one.verdict === "highlight" || one.verdict === "lowlight",
  );
  const movementText = judged.length === 0
    ? "임계를 넘은 변동이 없다."
    : judged
      .slice(0, MAX_MOVEMENTS)
      .map((one) => {
        const delta = one.change == null
          ? "신규"
          : one.spec.pointScale
            ? `${one.change >= 0 ? "+" : ""}${one.change.toFixed(1)}%p`
            : `${one.change >= 0 ? "+" : ""}${Math.round(one.change)}%`;
        return `${one.label} ${one.spec.ko} ${one.spec.format(one.latest)}(${delta})`;
      })
      .join(", ") + " 가 임계를 넘었다.";

  const gaps = input.ga4Gaps ?? [];
  const coverageText = gaps.length === 0
    ? `기준일 스냅샷이 대상 ${input.totals.ga4Dau.apps}개 앱에 모두 있다.`
    : `기준일 스냅샷이 없는 앱이 ${gaps.length}개 있다(${gaps
      .slice(0, MAX_NAMED_GAPS)
      .map((gap) => gap.app.displayName)
      .join(", ")}). 합계가 낮은 것이 실제 감소인지 이 앱들이 빠져서인지 먼저 가려야 한다.`;

  const action = gaps.length > 0
    ? "빠진 앱의 수집 상태를 먼저 확인한다. 지연이면 다음 정정에서 채워지고, 수집이 한 번도 없으면 배선을 봐야 한다."
    : judged.length > 0
      ? "위 변동의 앱별 지표를 열어 같은 방향의 움직임이 다른 소스에도 있는지 확인한다."
      : "확인할 변동이 없다. 다음 발행에서 같은 항목을 다시 본다.";

  return [
    `${NARRATIVE_SECTIONS[0]}`,
    movementText,
    "",
    `${NARRATIVE_SECTIONS[1]}`,
    coverageText,
    "",
    `${NARRATIVE_SECTIONS[2]}`,
    action,
  ].join("\n");
}

/** 세 절 머리말이 모두 있는가. 프롬프트가 요청만 하고 확인하지 않으면 형식이 흔들린다. */
export function hasNarrativeSections(text: string): boolean {
  return NARRATIVE_SECTIONS.every((section) => text.includes(section));
}

export interface MetricNarrative {
  text: string;
  /** LLM 문장이 아니라 골격으로 대체됐는가. */
  fallback: boolean;
  /** 문서에 남길 생성 출처. 골격이면 null. */
  provider: string | null;
  model: string | null;
  promptVersion: number;
}

/**
 * 해설. **항상 문자열을 돌려준다** — LLM 미설정·실패·형식 이탈이면 결정적 골격으로
 * 대체한다. 보고서가 LLM 가용성에 묶이면 안 되고, 있다 없다 하는 해설은 없느니만 못하다.
 *
 * temperature 0 으로 부르고 세 절 머리말을 검증한다. 형식이 어긋나면 한 번만 다시
 * 요청하고, 그래도 어긋나면 골격을 쓴다. 길이는 자르지 않는다 — 잘라내면 마지막 절이
 * 문장 중간에서 끊겨 "오늘은 형식이 다르다"로 읽힌다.
 */
export async function metricNarrative(input: NarrativeInput): Promise<MetricNarrative> {
  const skeleton = narrativeSkeleton(input);
  const asFallback = (): MetricNarrative => ({
    text: skeleton,
    fallback: true,
    provider: null,
    model: null,
    promptVersion: NARRATIVE_PROMPT_VERSION,
  });
  if (!llmChatConfigured()) return asFallback();

  const facts = narrativeFacts(input);
  const ask = async (extra?: string): Promise<string> => {
    const reply = await llmChat(
      [
        { role: "system", content: extra ? `${SYSTEM_PROMPT}\n\n${extra}` : SYSTEM_PROMPT },
        { role: "user", content: facts },
      ],
      { maxTokens: 1_400, temperature: 0, usage: { path: "metric-narrative" } },
    );
    // 세 절 머리말을 쓰게 했으므로 줄바꿈을 보존한다. 줄 안쪽 공백만 정리한다.
    return reply.trim().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  };

  try {
    let text = await ask();
    if (!hasNarrativeSections(text)) {
      text = await ask(
        `형식 위반이 있었다. 다음 세 머리말을 각각 한 줄로 그대로 포함해 다시 쓴다: ${NARRATIVE_SECTIONS.join(" / ")}`,
      );
    }
    if (!text || !hasNarrativeSections(text)) return asFallback();
    return {
      text,
      fallback: false,
      provider: env.chatLlmProvider(),
      model: llmChatModel(),
      promptVersion: NARRATIVE_PROMPT_VERSION,
    };
  } catch (error) {
    console.error(
      "[metric-highlights] 해설 생성 실패:",
      error instanceof Error ? error.message : error,
    );
    return asFallback();
  }
}
