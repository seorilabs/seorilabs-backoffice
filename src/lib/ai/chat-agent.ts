import { miniMaxChat, type ChatMessage } from "@/lib/ai/minimax";
import { TOOLS, runTool } from "@/lib/ai/tools";

// 도구 보강 채팅 루프. 모델이 JSON 으로 도구를 호출하면 실행해 되먹이고,
// {"final":...} 또는 비-JSON 이면 최종 답변으로 본다. 지연 억제 위해 라운드 제한.
const MAX_ROUNDS = 3;

interface ParsedAction {
  tool?: string;
  args?: Record<string, unknown>;
  final?: string;
}

function tryParseAction(raw: string): ParsedAction | null {
  try {
    const obj = JSON.parse(raw) as ParsedAction;
    if (obj && typeof obj === "object") return obj;
    return null;
  } catch {
    return null;
  }
}

function toolInstructions(): string {
  const spec = TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  return [
    "",
    "## 데이터 도구",
    "수치/목록 등 사실이 필요하면 추측하지 말고 도구로 조회한다.",
    '도구가 필요하면 다른 말 없이 JSON 만 출력: {"tool":"이름","args":{...}}',
    '충분하면 JSON 으로 최종 답변: {"final":"사용자에게 보낼 한국어 답변"}',
    "사용 가능 도구:",
    spec,
  ].join("\n");
}

/**
 * messages: [system, ...history, user]. system 에 도구 안내를 덧붙여 루프 실행.
 * 항상 사용자에게 보여줄 최종 텍스트를 반환.
 */
export async function runChatAgent(messages: ChatMessage[]): Promise<string> {
  const [system, ...rest] = messages;
  const convo: ChatMessage[] = [
    { role: "system", content: (system?.content ?? "") + "\n" + toolInstructions() },
    ...rest,
  ];

  let lastRaw = "";
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const raw = await miniMaxChat(convo, {
      temperature: 0.3,
      maxTokens: 1100,
      jsonOutput: true,
    });
    lastRaw = raw;
    const parsed = tryParseAction(raw);
    if (!parsed) return raw; // JSON 아님 → 그대로 답변
    if (typeof parsed.final === "string") return parsed.final;
    if (parsed.tool) {
      const result = await runTool(parsed.tool, parsed.args ?? {});
      convo.push({ role: "assistant", content: raw });
      convo.push({ role: "user", content: `[도구 ${parsed.tool} 결과]\n${result}` });
      continue;
    }
    return raw;
  }

  // 라운드 소진 → 도구 없이 최종 정리 1회.
  const final = await miniMaxChat(
    [...convo, { role: "user", content: "지금까지 정보로 한국어 최종 답변만 작성." }],
    { temperature: 0.4, maxTokens: 1100 },
  );
  return final || lastRaw;
}
