import { acquireAnalysisPermit, releaseAnalysisPermit } from "./budget";
import { minimaxChat } from "@/lib/ai/minimax";
import { env } from "@/lib/env";
import {
  validatedEvidence,
  fallbackInsight,
  insightPrompt,
  validateInsight,
  type Evidence,
  type Insight,
  type Persona,
} from "./contract";

export async function generateInsight(
  facts: Evidence[],
  persona: Persona,
  input: {
    chat?: typeof minimaxChat;
    configured?: boolean;
    reserve?: () => Promise<boolean>;
    acquire?: () => Promise<string | null>;
    release?: (id: string) => Promise<void>;
  } = {},
): Promise<{ content: Insight; fallback: boolean; errorCode: string | null }> {
  validatedEvidence(facts);
  const fallback = (code: string) => ({
    content: fallbackInsight(facts),
    fallback: true,
    errorCode: code,
  });
  if (!(input.configured ?? env.minimaxChatConfigured())) return fallback("MINIMAX_NOT_CONFIGURED");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (input.reserve && !(await input.reserve())) return fallback("DAILY_ANALYSIS_LIMIT");
    let permit: string | null;
    try {
      permit = await (input.acquire ?? acquireAnalysisPermit)();
    } catch {
      return fallback("ANALYSIS_ADMISSION_FAILED");
    }
    if (!permit) return fallback("ANALYSIS_LIMIT_OR_BUSY");
    try {
      const text = await (input.chat ?? minimaxChat)(
        [
          {
            role: "system",
            content:
              insightPrompt(persona) +
              (attempt
                ? "\n이전 형식이 잘못됐음. 근거 ID·자리표시자·음슴체 규약을 반드시 준수함."
                : ""),
          },
          { role: "user", content: JSON.stringify({ facts }) },
        ],
        {
          jsonOutput: true,
          maxTokens: 1200,
          temperature: 0,
          usage: { path: "operations-insights" },
        },
      );
      return {
        content: validateInsight(JSON.parse(text), facts),
        fallback: false,
        errorCode: null,
      };
    } catch (error) {
      // 비밀값이나 외부 원문이 포함될 수 있는 provider 오류는 영구 저장하지 않는다.
      if (
        !(error instanceof SyntaxError) &&
        !(error instanceof Error && /INSIGHT_|Zod/.test(error.message)) &&
        (error as { name?: string }).name !== "ZodError"
      )
        return fallback("ANALYSIS_PROVIDER_FAILED");
    } finally {
      await (input.release ?? releaseAnalysisPermit)(permit).catch(() => {});
    }
  }
  return fallback("ANALYSIS_FORMAT_INVALID");
}
