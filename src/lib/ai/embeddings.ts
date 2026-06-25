import { env } from "@/lib/env";

// 임베딩 = Google Gemini(gemini-embedding-001). MiniMax 국제(.io)는 임베딩 미제공이라
// 챗(MiniMax-M3)과 별개 제공자를 사용. 챗/추론은 그대로 MiniMax 가 담당.
// - taskType: "db"(문서 색인=RETRIEVAL_DOCUMENT) | "query"(질의=RETRIEVAL_QUERY) — 비대칭.
// - outputDimensionality 로 차원 축소(저장 절약). cosine 은 스케일 불변이라 정규화 불필요.
// 서버 전용(API 키). 절대 클라이언트 번들에 포함하지 말 것.

const MAX_TEXT_CHARS = 4000; // 단일 텍스트 상한(토큰/요금 보호)
const BATCH = 32; // batchEmbedContents 한 번에 보낼 수(rate/payload 보호)
// 무료등급 임베딩은 ~2 req/min 수준으로 박함 → 429 를 "스킵"이 아니라 "기다렸다 재시도"로.
// Retry-After 헤더 있으면 우선, 없으면 고정 대기. 인내심 있게 여러 번(백필 완주용).
const MAX_RETRY = 8;
const RETRY_429_WAIT_MS = 20_000;

export class EmbeddingsNotConfiguredError extends Error {
  constructor() {
    super("임베딩이 비활성 상태입니다 (GEMINI_API_KEY 필요).");
    this.name = "EmbeddingsNotConfiguredError";
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function taskFor(type: "db" | "query"): string {
  return type === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BatchResponse {
  error?: { message?: string; status?: string };
  embeddings?: Array<{ values?: number[] }>;
}

async function embedBatch(
  texts: string[],
  type: "db" | "query",
): Promise<number[][]> {
  const base = env.geminiBaseUrl().replace(/\/+$/, "");
  const model = env.geminiEmbedModel();
  const dim = env.geminiEmbedDim();
  const url = `${base}/models/${model}:batchEmbedContents`;
  const body = {
    requests: texts.map((t) => ({
      model: `models/${model}`,
      content: { parts: [{ text: truncate(t, MAX_TEXT_CHARS) }] },
      taskType: taskFor(type),
      outputDimensionality: dim,
    })),
  };

  let lastErr = "";
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.geminiTimeoutMs());
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.geminiApiKey(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const rawText = await response.text();
      if (response.status === 429) {
        // rate limit → Retry-After(초) 우선, 없으면 고정 대기 후 재시도(스킵 금지).
        const ra = Number(response.headers.get("retry-after"));
        lastErr = `429: ${truncate(rawText, 200)}`;
        await sleep(ra > 0 ? Math.min(ra * 1000, 30_000) : RETRY_429_WAIT_MS);
        continue;
      }
      if (response.status >= 500) {
        lastErr = `${response.status}: ${truncate(rawText, 200)}`;
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      if (!response.ok) {
        throw new Error(`Gemini 임베딩 실패 (${response.status}): ${truncate(rawText, 400)}`);
      }
      let parsed: BatchResponse;
      try {
        parsed = JSON.parse(rawText) as BatchResponse;
      } catch {
        throw new Error(`Gemini 임베딩 비 JSON 응답: ${truncate(rawText, 400)}`);
      }
      if (parsed.error) {
        throw new Error(`Gemini 임베딩 거부: ${parsed.error.message ?? parsed.error.status}`);
      }
      const vectors = (parsed.embeddings ?? []).map((e) => e.values ?? []);
      if (vectors.length !== texts.length) {
        throw new Error(`Gemini 임베딩 개수 불일치: ${vectors.length} != ${texts.length}`);
      }
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Gemini 임베딩 재시도 소진: ${lastErr}`);
}

/**
 * 여러 텍스트를 임베딩. 입력 순서를 보존해 number[][] 반환.
 * type="db" 색인용 / "query" 질의용(비대칭 taskType).
 */
export async function embedTexts(
  texts: string[],
  type: "db" | "query",
): Promise<number[][]> {
  if (!env.geminiConfigured()) throw new EmbeddingsNotConfiguredError();
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await embedBatch(texts.slice(i, i + BATCH), type)));
  }
  return out;
}

/** 단일 질의 임베딩 헬퍼. */
export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await embedTexts([text], "query");
  return v ?? [];
}
