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
  allowlistLogins: () =>
    optional("ALLOWLIST_LOGINS", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  reconcileIntervalMs: () =>
    Number(optional("RECONCILE_INTERVAL_MS", "21600000")),
};
