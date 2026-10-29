export interface SlackResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  terminal?: boolean;
  retryAfterMs?: number;
  statusCode?: number;
  messageId?: string;
}

const CREATES = new Set(["chat.postMessage", "chat.postEphemeral", "files.completeUploadExternal", "views.open", "views.push"]);
const FORM_METHODS = new Set(["users.info", "files.info", "files.delete", "files.getUploadURLExternal", "conversations.info", "conversations.members", "conversations.list"]);
const PERMANENT = new Set(["invalid_auth", "account_inactive", "token_revoked", "missing_scope", "not_authed", "channel_not_found", "not_in_channel", "is_archived", "restricted_action", "cant_update_message", "cant_delete_message", "invalid_arguments", "invalid_blocks", "invalid_trigger", "expired_trigger_id", "message_not_found", "file_not_found"]);

export async function slackApi(method: string, payload: Record<string, unknown>, options: { token?: string; request?: typeof fetch; timeoutMs?: number } = {}): Promise<SlackResult> {
  const token = options.token ?? process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return { ok: false, error: "SLACK_BOT_NOT_CONFIGURED", terminal: true };
  if (!/^[a-z]+\.[A-Za-z]+$/.test(method)) return { ok: false, error: "SLACK_METHOD_INVALID", terminal: true };
  let response: Response;
  const form = FORM_METHODS.has(method);
  try {
    response = await (options.request ?? fetch)(`https://slack.com/api/${method}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": form ? "application/x-www-form-urlencoded; charset=utf-8" : "application/json; charset=utf-8" },
      body: form ? new URLSearchParams(Object.entries(payload).map(([key,value]) => [key,String(value)])) : JSON.stringify(payload), signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
  } catch {
    return { ok: false, error: CREATES.has(method) ? "SLACK_DELIVERY_OUTCOME_UNKNOWN" : "SLACK_REQUEST_UNAVAILABLE", terminal: CREATES.has(method) };
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    return { ok: false, error: "ratelimited", statusCode: 429, terminal: false, retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 30000 };
  }
  if (!response.ok) return { ok: false, statusCode: response.status, error: CREATES.has(method) && response.status >= 500 ? "SLACK_DELIVERY_OUTCOME_UNKNOWN" : `SLACK_HTTP_${response.status}`, terminal: response.status < 500 || CREATES.has(method) };
  let data: Record<string, unknown>;
  try { data = await response.json() as Record<string, unknown>; }
  catch { return { ok: false, error: CREATES.has(method) ? "SLACK_DELIVERY_OUTCOME_UNKNOWN" : "SLACK_RESPONSE_INVALID", terminal: CREATES.has(method) }; }
  if (!data || typeof data !== "object" || Array.isArray(data) || (data.ok !== true && data.ok !== false)) return {ok:false,error:CREATES.has(method) ? "SLACK_DELIVERY_OUTCOME_UNKNOWN" : "SLACK_RESPONSE_INVALID",terminal:CREATES.has(method)};
  if (data.ok !== true) {
    const error = typeof data.error === "string" && /^[a-z_]{1,80}$/.test(data.error) ? data.error : "SLACK_RESPONSE_INVALID";
    return { ok: false, error, statusCode: response.status, terminal: PERMANENT.has(error) };
  }
  return { ok: true, data, statusCode: response.status, ...(typeof data.ts === "string" ? { messageId: data.ts } : {}) };
}

/** response_url은 짧게 유효한 인증 정보다. 저장하지 않고 서명된 요청 처리 중에만 쓴다. */
export async function respondSlack(url: string, payload: Record<string, unknown>, request: typeof fetch = fetch): Promise<boolean> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "hooks.slack.com" || parsed.username || parsed.password || parsed.port || !/^\/(commands|actions)\//.test(parsed.pathname)) return false;
  try {
    const response = await request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000), redirect: "error" });
    return response.ok;
  } catch { return false; }
}
