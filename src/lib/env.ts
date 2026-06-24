// 환경변수 접근 헬퍼. 빌드 시점 크래시를 피하려 런타임 lazy 접근.

function get(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env: ${key}`);
  }
  return v;
}

function optional(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

function bool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

export const env = {
  get,
  optional,
  bool,
  githubOrg: () => optional("GITHUB_ORG", "seorilabs"),
  featureMinimax: () => bool("FEATURE_MINIMAX_ENABLED", false),
  // MiniMax (OpenAI 호환 Chat Completions, gemini-pr-bot 와 동일 형태)
  minimaxApiKey: () => optional("MINIMAX_API_KEY"),
  minimaxModel: () => optional("MINIMAX_MODEL", "MiniMax-M3"),
  minimaxBaseUrl: () =>
    optional("MINIMAX_API_BASE_URL", "https://api.minimax.io/v1"),
  minimaxTimeoutMs: () => Number(optional("MINIMAX_TIMEOUT_MS", "180000")),
  // 실제 LLM 호출 가능 여부: 플래그 ON + 키 존재.
  minimaxConfigured: () =>
    bool("FEATURE_MINIMAX_ENABLED", false) &&
    Boolean(optional("MINIMAX_API_KEY").trim()),
  allowlistLogins: () =>
    optional("ALLOWLIST_LOGINS", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  reconcileIntervalMs: () =>
    Number(optional("RECONCILE_INTERVAL_MS", "21600000")),
  telegramEnabled: () => bool("FEATURE_TELEGRAM_ENABLED", false),
  telegramToken: () => optional("TELEGRAM_BOT_TOKEN"),
  telegramWebhookSecret: () => optional("TELEGRAM_WEBHOOK_SECRET"),
  telegramChatId: () => optional("TELEGRAM_CHAT_ID"),
  telegramAllowedIds: () =>
    optional("TELEGRAM_ALLOWED_IDS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
};
