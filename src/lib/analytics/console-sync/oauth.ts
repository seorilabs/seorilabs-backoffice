import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
export const MCP_URL = "https://mcp.toss.im/adapters/apps-in-toss-console/mcp";
export const TOKEN_URL = "https://business-accounts.toss.im/oauth2/token";
export class ConsoleSyncError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ConsoleSyncError"; }
}
const schema = z.object({
  credentialId: z.string().regex(/^shared\/apps-in-toss\/[a-z0-9-]+$/), clientId: z.literal("mcp-gateway"),
  refreshToken: z.string().min(1), accessToken: z.string().min(1).optional(), expiresAt: z.number().int().positive().optional(),
});
export type ConsoleCredential = z.infer<typeof schema>;
export async function loadConsoleCredential(file?: string, credentialId?: string) {
  if (!file || !credentialId) throw new ConsoleSyncError("OAUTH_CREDENTIAL_REQUIRED");
  try {
    const info = await stat(file);
    const privateGroup = (info.mode & 0o020) === 0 && info.gid === process.getgid?.();
    if (!info.isFile() || (info.mode & 0o007) !== 0 || ((info.mode & 0o070) !== 0 && !privateGroup)) throw new ConsoleSyncError("OAUTH_FILE_NOT_PRIVATE");
    const result = schema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!result.success || result.data.credentialId !== credentialId) throw new ConsoleSyncError("OAUTH_IDENTITY_MISMATCH");
    return result.data;
  } catch (error) {
    if (error instanceof ConsoleSyncError) throw error;
    throw new ConsoleSyncError("OAUTH_CREDENTIAL_UNREADABLE");
  }
}
const tokenSchema = z.object({ access_token: z.string().min(1), token_type: z.string().refine((v) => v.toLowerCase() === "bearer"), expires_in: z.number().finite().positive(), refresh_token: z.string().min(1).optional() });
export class ConsoleOAuth {
  private accessToken?: string;
  private expiresAt = 0;
  private refreshing?: Promise<void>;
  private stopped?: string;
  get failureCode() { return this.stopped; }
  constructor(private readonly credential: ConsoleCredential, private readonly fetchFn: typeof fetch = fetch) { this.accessToken = credential.accessToken; this.expiresAt = credential.expiresAt ?? 0; }
  async refresh(signal?: AbortSignal) {
    if (this.stopped) throw new ConsoleSyncError(this.stopped);
    this.refreshing ??= this.exchange(signal).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async exchange(signal?: AbortSignal) {
    let response: Response;
    try {
      response = await this.fetchFn(TOKEN_URL, { method: "POST", redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.credential.clientId, refresh_token: this.credential.refreshToken, resource: "https://mcp.toss.im" }),
      });
    } catch { throw new ConsoleSyncError("OAUTH_REFRESH_NETWORK_ERROR"); }
    let body: unknown;
    try { body = await response.json(); } catch { throw new ConsoleSyncError("OAUTH_RESPONSE_INVALID"); }
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body);
      const codes: Record<string, string> = { invalid_grant: "REAUTHENTICATION_REQUIRED", invalid_client: "OAUTH_CLIENT_CONFIGURATION_INVALID", invalid_target: "OAUTH_RESOURCE_CONFIGURATION_INVALID", invalid_scope: "OAUTH_RESOURCE_CONFIGURATION_INVALID", unsupported_grant_type: "OAUTH_REFRESH_NOT_SUPPORTED" };
      if (error.success && codes[error.data.error]) this.stopped = codes[error.data.error];
      else if ([401, 403].includes(response.status)) this.stopped = "REAUTHENTICATION_REQUIRED";
      else if (response.status === 400) this.stopped = "OAUTH_REQUEST_REJECTED";
      throw new ConsoleSyncError(this.stopped ?? "OAUTH_REFRESH_UNAVAILABLE");
    }
    // 새 refresh를 이미 발급한 응답은 다른 필드가 깨져 있어도 옛 토큰을 다시 사용하지 않는다.
    const rotation = z.object({ refresh_token: z.string().min(1) }).safeParse(body);
    if (rotation.success && rotation.data.refresh_token !== this.credential.refreshToken) { this.stopped = "OAUTH_ROTATION_REQUIRES_REVIEW"; throw new ConsoleSyncError(this.stopped); }
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) throw new ConsoleSyncError("OAUTH_RESPONSE_INVALID");
    this.accessToken = parsed.data.access_token; this.expiresAt = Date.now() + parsed.data.expires_in * 1000;
  }
  async fetch(input: string | URL | Request, init?: RequestInit) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== MCP_URL) throw new ConsoleSyncError("MCP_HOST_NOT_ALLOWED");
    if (this.stopped) throw new ConsoleSyncError(this.stopped);
    if (!this.accessToken || this.expiresAt <= Date.now() + 30_000) await this.refresh(init?.signal ?? undefined);
    const send = () => {
      const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${this.accessToken}`);
      return this.fetchFn(input, { ...init, headers, redirect: "error", signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) });
    };
    const rejectedToken = this.accessToken;
    let response = await send();
    if (response.status === 401) { await response.body?.cancel(); if (rejectedToken === this.accessToken) await this.refresh(init?.signal ?? undefined); response = await send(); }
    if ([401, 403].includes(response.status)) { await response.body?.cancel(); this.stopped = "REAUTHENTICATION_REQUIRED"; throw new ConsoleSyncError(this.stopped); }
    return response;
  }
}
export function consoleErrorCode(error: unknown) { return error instanceof ConsoleSyncError ? error.code : "CONSOLE_REQUEST_FAILED"; }
