import { geminiChat } from "@/lib/ai/gemini";
import { env } from "@/lib/env";
import type { Movement, PortfolioTotals } from "@/lib/core/metric-highlights";

// 지표 하이라이트에 붙이는 한 문단 해설.
//
// 판정·순위·수치는 전부 결정적 코드가 낸다. LLM 은 **이미 계산된 결과만** 받아
// "왜 그럴 수 있는지, 무엇을 먼저 볼지"를 쓴다. 새 수치를 만들 재료를 주지 않으므로
// 환각이 리포트의 숫자를 오염시킬 수 없고, 실패하면 해설만 빠진다.

const MAX_MOVEMENTS = 8;
const MAX_CHARS = 400;

/** 해설이 참고할 수 있는 사실만 담은 요약. 원본 스냅샷은 넘기지 않는다. */
export function narrativeFacts(input: {
  refDate: string;
  totals: PortfolioTotals;
  movements: readonly Movement[];
}): string {
  const lines = [
    `기준일: ${input.refDate} (D-1)`,
    `GA4 DAU 합계 ${input.totals.ga4Dau.latest}명 (전일 ${input.totals.ga4Dau.previous ?? "미상"}) · 대상 ${input.totals.ga4Dau.apps}개 앱`,
    `콘솔 광고 수익 ${Math.round(input.totals.console.iaaKrw)}원 · 결제 ${Math.round(input.totals.console.iapKrw)}원 · 대상 ${input.totals.console.listings}개 리스팅`,
  ];
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
  "아래는 이미 계산이 끝난 어제 지표 변동이다. 이 사실만으로 해설을 쓴다.",
  "",
  "규칙:",
  "- 주어진 사실에 없는 수치를 새로 만들거나 계산하지 않는다. 숫자를 인용할 때는 그대로 옮긴다.",
  "- 원인을 단정하지 않는다. 가능성은 '~일 수 있다'로 쓰고, 확인 방법을 함께 적는다.",
  "- 같은 앱이 여러 소스에서 같은 방향으로 움직였으면 그 일치를 짚는다. 표면 이동이 아니라 실제 변화라는 신호다.",
  "- 표본 부족·변동 없음 건수가 많다고 해서 문제라고 말하지 않는다. 규모가 작으면 정상이다.",
  "- 한국어로 결론부터. 2~4문장, 최대 300자. 목록·제목·인사말 없이 문단 하나만.",
].join("\n");

/**
 * 해설 한 문단. Gemini 미설정·실패·빈 응답이면 null 을 돌려 호출부가 해설 없이 진행한다.
 * 리포트 발송이 LLM 가용성에 묶이면 안 된다.
 */
export async function metricNarrative(facts: string): Promise<string | null> {
  if (!env.geminiChatConfigured()) return null;
  try {
    const reply = await geminiChat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: facts },
      ],
      { maxTokens: 400, usage: { path: "metric-narrative" } },
    );
    const text = reply.trim().replace(/\s+/g, " ");
    return text ? text.slice(0, MAX_CHARS) : null;
  } catch (error) {
    console.error(
      "[metric-highlights] 해설 생성 실패:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
