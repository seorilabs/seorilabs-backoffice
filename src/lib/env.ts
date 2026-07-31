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
  // Godot 버전 감지 알림: global-versions.yaml 의 tools.godot.version 을 미러링.
  // kubectl 워크스페이스가 git 이 아니라 fetch 불가 → env 로 pin 값 주입.
  godotPinnedVersion: () => optional("GODOT_PINNED_VERSION", "4.6.3"),
  featureGemini: () => bool("FEATURE_GEMINI_ENABLED", false),
  // Gemini API: Flash-Lite 챗/초안 + gemini-embedding-001 볼트 질의 임베딩.
  geminiApiKey: () => optional("GEMINI_API_KEY"),
  geminiChatModel: () => optional("GEMINI_CHAT_MODEL", "gemini-3.1-flash-lite"),
  geminiChatTimeoutMs: () => Number(optional("GEMINI_CHAT_TIMEOUT_MS", "180000")),
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
  // 실제 챗/초안 호출 가능 여부: 플래그 ON + 회사 키 존재.
  geminiChatConfigured: () =>
    bool("FEATURE_GEMINI_ENABLED", false) &&
    Boolean(optional("GEMINI_API_KEY").trim()),
  // 일일 병합 요약 Gemini 적용률. 확정적 PR 목록은 항상 발송하고 AI 한 줄만 날짜별 샘플링.
  dailyDigestGeminiRolloutPercent: () =>
    Number(optional("DAILY_DIGEST_GEMINI_ROLLOUT_PERCENT", "10")),
  allowlistLogins: () =>
    optional("ALLOWLIST_LOGINS", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  reconcileIntervalMs: () =>
    Number(optional("RECONCILE_INTERVAL_MS", "21600000")),
  // GA4→BigQuery 지표 수집. SA 키(JSON 문자열)로 BigQuery 조회.
  featureGa4: () => bool("FEATURE_GA4_ANALYTICS", false),
  ga4SaKeyJson: () => optional("GA4_SA_KEY_JSON"),
  ga4Configured: () =>
    bool("FEATURE_GA4_ANALYTICS", false) &&
    Boolean(optional("GA4_SA_KEY_JSON").trim()),
  // 공통 플랫폼 Admin API. 런타임 유저 데이터의 SoT는 플랫폼이다.
  // 백오피스는 앱 Firestore를 직접 만지지 않고 이 API만 부른다.
  featurePlatform: () => bool("FEATURE_PLATFORM_ADMIN", false),
  platformAdminUrl: () => optional("PLATFORM_ADMIN_URL"),
  platformAdminSaKeyJson: () => optional("PLATFORM_ADMIN_SA_KEY_JSON"),
  platformConfigured: () =>
    bool("FEATURE_PLATFORM_ADMIN", false) &&
    Boolean(optional("PLATFORM_ADMIN_URL").trim()) &&
    Boolean(optional("PLATFORM_ADMIN_SA_KEY_JSON").trim()),
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
