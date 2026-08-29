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

export function parseDiscordRetentionDays(value: string | undefined): number {
  const parsed = Number(value ?? "30");
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(365, Math.max(1, Math.floor(parsed)));
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
  // GA4→BigQuery 지표 수집. SA 키(JSON 문자열)로 BigQuery 조회.
  featureGa4: () => bool("FEATURE_GA4_ANALYTICS", false),
  ga4SaKeyJson: () => optional("GA4_SA_KEY_JSON"),
  ga4Configured: () =>
    bool("FEATURE_GA4_ANALYTICS", false) &&
    Boolean(optional("GA4_SA_KEY_JSON").trim()),
  // 공통 플랫폼 Admin API. 런타임 유저 데이터의 SoT는 플랫폼이다.
  //
  // 읽기와 쓰기 서비스 계정을 분리한다. 웹 Pod에는 read 계정만,
  // Kubernetes AppOps worker에는 write 계정만 주입한다. read 키 유출만으로
  // Admin API mutation을 직접 호출하거나 write 키를 탈취할 수 없게 한다.
  // queue/MySQL 무결성은 별도 신뢰 경계이며 worker가 현재 권한을 재검증한다.
  featurePlatform: () => bool("FEATURE_PLATFORM_ADMIN", false),
  featurePlatformWrites: () =>
    bool("FEATURE_PLATFORM_ADMIN_WRITES", false),
  platformAdminUrl: () => optional("PLATFORM_ADMIN_URL"),
  platformAdminReadSaKeyJson: () => optional("PLATFORM_ADMIN_READ_SA_KEY_JSON"),
  platformAdminWriteSaKeyJson: () => optional("PLATFORM_ADMIN_WRITE_SA_KEY_JSON"),
  platformReadConfigured: () =>
    bool("FEATURE_PLATFORM_ADMIN", false) &&
    Boolean(optional("PLATFORM_ADMIN_URL").trim()) &&
    Boolean(optional("PLATFORM_ADMIN_READ_SA_KEY_JSON").trim()),
  platformWriteConfigured: () =>
    bool("FEATURE_PLATFORM_ADMIN", false) &&
    bool("FEATURE_PLATFORM_ADMIN_WRITES", false) &&
    Boolean(optional("PLATFORM_ADMIN_URL").trim()) &&
    Boolean(optional("PLATFORM_ADMIN_WRITE_SA_KEY_JSON").trim()),
  // 기존 앱별 worker 어댑터의 호출부는 write 전용 설정을 사용한다.
  // 이름을 남겨 점진적으로 전환하되, 과거 단일 SA 환경변수로 fallback하지
  // 않는다. 잘못된 Pod에 쓰기 키가 들어가는 것보다 명시적 미설정이 안전하다.
  platformAdminSaKeyJson: () => optional("PLATFORM_ADMIN_WRITE_SA_KEY_JSON"),
  platformConfigured: () =>
    bool("FEATURE_PLATFORM_ADMIN", false) &&
    Boolean(optional("PLATFORM_ADMIN_URL").trim()) &&
    Boolean(optional("PLATFORM_ADMIN_WRITE_SA_KEY_JSON").trim()),
  // Google Play Developer API 리뷰 조회용 공용 publisher service account.
  // 리뷰 collector CronJob에만 주입하고 웹/Discord worker에는 전달하지 않는다.
  googlePlayServiceAccountJson: () =>
    optional("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON").trim(),
  appStoreConnectConfigured: () =>
    Boolean(optional("APP_STORE_CONNECT_API_KEY_ID").trim()) &&
    Boolean(optional("APP_STORE_CONNECT_ISSUER_ID").trim()) &&
    Boolean(optional("APP_STORE_CONNECT_PRIVATE_KEY_BASE64").trim()),
  discordApplicationId: () => optional("DISCORD_APPLICATION_ID").trim(),
  discordPublicKey: () => optional("DISCORD_PUBLIC_KEY").trim(),
  discordBotToken: () => optional("DISCORD_BOT_TOKEN").trim(),
  discordGuildId: () => optional("DISCORD_GUILD_ID").trim(),
  discordConfigured: () =>
    Boolean(optional("DISCORD_APPLICATION_ID").trim()) &&
    Boolean(optional("DISCORD_PUBLIC_KEY").trim()) &&
    Boolean(optional("DISCORD_BOT_TOKEN").trim()) &&
    Boolean(optional("DISCORD_GUILD_ID").trim()),
  // 서리 재무 비용 순찰 소스. 전부 선택적 — 미설정 소스는 리포트에 "미설정" 으로 표기.
  githubBillingToken: () => optional("GITHUB_BILLING_TOKEN").trim(),
  // GitHub 플랜 포함 hosted 분량(macOS 10x·Windows 2x 환산 기준). Team 플랜 3,000분.
  githubIncludedQuotaMinutes: () => Number(optional("GITHUB_INCLUDED_QUOTA_MINUTES", "3000")),
  // billing export 테이블 전체 경로 "project.dataset.gcp_billing_export_v1_XXXX".
  gcpBillingExportTable: () => optional("GCP_BILLING_EXPORT_TABLE").trim(),
  // 0 = 예산 미확정(보고만). 첫 달 실측 후 확정한다.
  gcpMonthlyBudgetKrw: () => Number(optional("GCP_MONTHLY_BUDGET_KRW", "0")),
  stabilityApiKey: () => optional("STABILITY_API_KEY").trim(),
  stabilityMinCredits: () => Number(optional("STABILITY_MIN_CREDITS", "200")),
  // 0 = LLM 월 예산 미확정(보고만). 유료 provider 도입 후 실측으로 확정한다.
  llmMonthlyBudgetUsd: () => Number(optional("LLM_MONTHLY_BUDGET_USD", "0")),
  // 서리(운영 총괄) 봇. 일일 재무 리포트를 이 정체로 게시한다. 미설정이면 메인 봇으로
  // 나가므로 리포트가 사라지지는 않는다.
  discordSeoriBotToken: () => optional("DISCORD_TEAMMATE_SEORI_BOT_TOKEN").trim(),
  discordChannelId: (key: string) =>
    optional(`DISCORD_CHANNEL_${key.toUpperCase().replace(/-/g, "_")}_ID`).trim(),
  discordRoleId: (key: string) =>
    optional(`DISCORD_ROLE_${key.toUpperCase().replace(/-/g, "_")}_ID`).trim(),
  discordRetentionDays: () =>
    parseDiscordRetentionDays(optional("DISCORD_RETENTION_DAYS", "30")),
  natsServerUrl: () => optional("NATS_SERVER_URL", "nats://nats.data.svc.cluster.local:4222"),
  platformEventSharedSecret: () => optional("PLATFORM_EVENT_SHARED_SECRET"),
};
