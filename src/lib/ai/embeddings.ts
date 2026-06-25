import { env } from "@/lib/env";
import { MiniMaxNotConfiguredError } from "@/lib/ai/minimax";

// MiniMax 임베딩(embo-01). 챗과 별개 엔드포인트 /v1/embeddings.
// - type: "db"(문서 색인) | "query"(질의) — MiniMax 가 비대칭 임베딩을 지원.
// - 응답은 { vectors: number[][] }(MiniMax 네이티브) 또는 OpenAI 호환 { data:[{embedding}] }.
// - GroupId 가 필요한 엔드포인트면 MINIMAX_GROUP_ID 를 쿼리스트링으로 부착.
// 서버 전용(API 키). 절대 클라이언트 번들에 포함하지 말 것.

// 단일 텍스트 상한(임베딩 토큰 한도·요금 보호). 청크가 이보다 크면 잘라서 임베딩.
const MAX_TEXT_CHARS = 4000;
// 한 번에 보낼 텍스트 수(rate 스파이크·페이로드 보호).
const BATCH = 16;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

interface EmbedResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  vectors?: number[][];
  data?: Array<{ embedding?: number[] }>;
}

async function embedBatch(
  texts: string[],
  type: "db" | "query",
): Promise<number[][]> {
  const baseUrl = env.minimaxBaseUrl().replace(/\/+$/, "");
  const groupId = env.minimaxGroupId().trim();
  const url =
    `${baseUrl}/embeddings` +
    (groupId ? `?GroupId=${encodeURIComponent(groupId)}` : "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.minimaxTimeoutMs());
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.minimaxApiKey()}`,
      },
      body: JSON.stringify({
        model: env.minimaxEmbedModel(),
        texts: texts.map((t) => truncate(t, MAX_TEXT_CHARS)),
        type,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(
        `MiniMax 임베딩 실패 (${response.status}): ${truncate(rawText, 500)}`,
      );
    }
    let parsed: EmbedResponse;
    try {
      parsed = JSON.parse(rawText) as EmbedResponse;
    } catch {
      throw new Error(`MiniMax 임베딩 비 JSON 응답: ${truncate(rawText, 500)}`);
    }
    const baseResp = parsed.base_resp;
    if (baseResp && Number(baseResp.status_code) !== 0) {
      const msg = baseResp.status_msg || `error code ${baseResp.status_code}`;
      throw new Error(`MiniMax 임베딩 거부: ${msg}`);
    }
    const vectors =
      parsed.vectors ??
      parsed.data?.map((d) => d.embedding ?? []) ??
      [];
    if (vectors.length !== texts.length) {
      throw new Error(
        `MiniMax 임베딩 개수 불일치: ${vectors.length} != ${texts.length}`,
      );
    }
    return vectors;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 여러 텍스트를 임베딩. 입력 순서를 보존해 number[][] 반환.
 * type="db" 색인용 / "query" 질의용(비대칭).
 */
export async function miniMaxEmbed(
  texts: string[],
  type: "db" | "query",
): Promise<number[][]> {
  if (!env.minimaxConfigured()) throw new MiniMaxNotConfiguredError();
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    out.push(...(await embedBatch(batch, type)));
  }
  return out;
}

/** 단일 질의 임베딩 헬퍼. */
export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await miniMaxEmbed([text], "query");
  return v ?? [];
}
