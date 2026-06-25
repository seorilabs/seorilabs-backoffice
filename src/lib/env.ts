// 환경변수 접근 헬퍼. 빌드 시점 크래시를 피하려 런타임 lazy 접근.
// (값은 K8s secret/deployment env 로 주입; 로컬은 .env)

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
  // 임베딩 = Gemini(gemini-embedding-001). MiniMax .io 는 임베딩 미제공이라 분리.
  geminiApiKey: () => optional("GEMINI_API_KEY"),
  geminiEmbedModel: () => optional("GEMINI_EMBED_MODEL", "gemini-embedding-001"),
  geminiBaseUrl: () =>
    optional("GEMINI_API_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"),
  geminiEmbedDim: () => Number(optional("GEMINI_EMBED_DIM", "1536")),
  geminiTimeoutMs: () => Number(optional("GEMINI_TIMEOUT_MS", "60000")),
  geminiConfigured: () => Boolean(optional("GEMINI_API_KEY").trim()),
  // Vault RAG(Obsidian 볼트 지식). 인덱서/라이터는 data ns 에서 PVC 마운트.
  featureVaultRag: () => bool("FEATURE_VAULT_RAG", false),
  vaultPath: () => optional("VAULT_PATH", "/vault"),
  // 인덱싱할 최상위 폴더 allowlist(쉼표 구분). 비면 전체(루트) 스캔.
  // 시크릿이 폴더 곳곳에 흩어져 있어 블록리스트보다 화이트리스트가 안전.
  vaultIncludeDirs: () =>
    optional("VAULT_INCLUDE_DIRS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  // 추가 제외 디렉터리(쉼표 구분, 하위 어디서나 이름 매칭). 옵시디언/sync 메타.
  vaultExcludeDirs: () =>
    optional("VAULT_EXCLUDE_DIRS", ".obsidian,.stfolder,.trash")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  // 에이전트가 쓸 수 있는 하위폴더 allowlist(라이터가 강제).
  vaultWriteFolders: () =>
    optional("VAULT_WRITE_FOLDERS", "받은함")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
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
