import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { CONSOLE_CREDENTIAL_ID, type ConsoleRuntimeLedger, type ConsoleRuntimeState } from "./runtime";
import type { ConsoleGrantVersions, StoredConsoleGrant } from "./versions";
export const MCP_URL = "https://mcp.toss.im/adapters/apps-in-toss-console/mcp";
export const TOKEN_URL = "https://business-accounts.toss.im/oauth2/token";
export class ConsoleSyncError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ConsoleSyncError"; }
}
export const consoleCredentialSchema = z.object({
  credentialId: z.literal(CONSOLE_CREDENTIAL_ID), clientId: z.literal("mcp-gateway"),
  refreshToken: z.string().min(1), accessToken: z.string().min(1).optional(), expiresAt: z.number().int().positive().optional(),
});
export type ConsoleCredential = z.infer<typeof consoleCredentialSchema>;
export async function loadConsoleCredential(file?: string, credentialId?: string) {
  if (!file || !credentialId) throw new ConsoleSyncError("OAUTH_CREDENTIAL_REQUIRED");
  try {
    const info = await stat(file);
    const privateGroup = (info.mode & 0o020) === 0 && info.gid === process.getgid?.();
    if (!info.isFile() || (info.mode & 0o007) !== 0 || ((info.mode & 0o070) !== 0 && !privateGroup)) throw new ConsoleSyncError("OAUTH_FILE_NOT_PRIVATE");
    const result = consoleCredentialSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!result.success || result.data.credentialId !== credentialId) throw new ConsoleSyncError("OAUTH_IDENTITY_MISMATCH");
    return result.data;
  } catch (error) {
    if (error instanceof ConsoleSyncError) throw error;
    throw new ConsoleSyncError("OAUTH_CREDENTIAL_UNREADABLE");
  }
}
const tokenSchema = z.object({ access_token: z.string().min(1), token_type: z.string().refine((v) => v.toLowerCase() === "bearer"), expires_in: z.number().finite().positive(), refresh_token: z.string().min(1) });
export class ConsoleOAuth {
  private accessToken?: string;
  private expiresAt = 0;
  private refreshing?: Promise<void>;
  private stopped?: string;
  get failureCode() { return this.stopped; }
  private constructor(private credential: StoredConsoleGrant, private state: ConsoleRuntimeState,
    private readonly versions: ConsoleGrantVersions, private readonly runtime: ConsoleRuntimeLedger, private readonly fetchFn: typeof fetch) {
    this.accessToken = credential.accessToken; this.expiresAt = credential.expiresAt ?? 0;
  }
  static async open(versions: ConsoleGrantVersions, runtime: ConsoleRuntimeLedger, fetchFn: typeof fetch = fetch) {
    await runtime.assertLease();
    const state = await runtime.read();
    if (state.phase !== "ACTIVE") throw new ConsoleSyncError("OAUTH_REFRESH_IN_FLIGHT");
    const grant = await versions.read(state.secretVersion);
    if (grant.credentialId !== state.credentialId || grant.generation !== state.generation) throw new ConsoleSyncError("OAUTH_GENERATION_MISMATCH");
    return new ConsoleOAuth(grant, state, versions, runtime, fetchFn);
  }
  private async assertCurrent() {
    await this.runtime.assertLease();
    const current = await this.runtime.read();
    if (current.generation !== this.state.generation || current.phase !== this.state.phase || current.secretVersion !== this.state.secretVersion || current.attemptId !== this.state.attemptId) throw new ConsoleSyncError("OAUTH_STATE_CONFLICT");
  }
  async refresh(signal?: AbortSignal) {
    if (this.stopped) throw new ConsoleSyncError(this.stopped);
    this.refreshing ??= this.exchange(signal).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async exchange(signal?: AbortSignal) {
    try {
      await this.assertCurrent();
      const expected = this.state, attemptId = randomUUID();
      this.state = await this.runtime.begin(expected, attemptId);
      if (this.state.phase !== "REFRESH_IN_FLIGHT" || this.state.generation !== expected.generation || this.state.secretVersion !== expected.secretVersion || this.state.attemptId !== attemptId) throw new ConsoleSyncError("OAUTH_STATE_READBACK_MISMATCH");
      await this.assertCurrent();
      this.credential = await this.versions.read(this.state.secretVersion);
      if (this.credential.generation !== this.state.generation || this.credential.credentialId !== this.state.credentialId) throw new ConsoleSyncError("OAUTH_GENERATION_MISMATCH");
    }
    catch { this.stopped = "OAUTH_STATE_PRESERVATION_FAILED"; throw new ConsoleSyncError(this.stopped); }
    let response: Response;
    try {
      response = await this.fetchFn(TOKEN_URL, { method: "POST", redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.credential.clientId, refresh_token: this.credential.refreshToken, resource: "https://mcp.toss.im" }),
      });
    } catch { this.stopped = "OAUTH_REFRESH_OUTCOME_UNKNOWN"; throw new ConsoleSyncError(this.stopped); }
    let body: unknown;
    try { body = await response.json(); } catch {
      if (response.ok) { this.stopped = "OAUTH_REFRESH_OUTCOME_UNKNOWN"; throw new ConsoleSyncError(this.stopped); }
      // 오류 응답의 HTML·빈 본문은 상태 코드로 처리한다.
    }
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body);
      const codes: Record<string, string> = { invalid_grant: "REAUTHENTICATION_REQUIRED", invalid_client: "OAUTH_CLIENT_CONFIGURATION_INVALID", invalid_target: "OAUTH_RESOURCE_CONFIGURATION_INVALID", invalid_scope: "OAUTH_RESOURCE_CONFIGURATION_INVALID", unsupported_grant_type: "OAUTH_REFRESH_NOT_SUPPORTED" };
      if (error.success && Object.hasOwn(codes, error.data.error)) this.stopped = codes[error.data.error];
      else if ([401, 403].includes(response.status)) this.stopped = "REAUTHENTICATION_REQUIRED";
      else if (response.status === 400) this.stopped = "OAUTH_REQUEST_REJECTED";
      this.stopped ??= "OAUTH_REFRESH_UNAVAILABLE";
      throw new ConsoleSyncError(this.stopped);
    }
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) { this.stopped = "OAUTH_REFRESH_OUTCOME_UNKNOWN"; throw new ConsoleSyncError(this.stopped); }
    const next: StoredConsoleGrant = { credentialId: CONSOLE_CREDENTIAL_ID, clientId: "mcp-gateway", generation: this.state.generation + 1,
      refreshToken: parsed.data.refresh_token, accessToken: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 };
    try {
      // 발급된 grant는 잠금 손실에도 우선 보존한다. 활성화 CAS는 잠금을 다시 확인한다.
      const version = await this.versions.add(next);
      const readback = await this.versions.read(version);
      if (readback.generation !== next.generation || readback.credentialId !== next.credentialId || readback.clientId !== next.clientId
        || readback.refreshToken !== next.refreshToken || readback.accessToken !== next.accessToken || readback.expiresAt !== next.expiresAt) throw new ConsoleSyncError("OAUTH_VERSION_READBACK_MISMATCH");
      await this.assertCurrent();
      this.state = await this.runtime.complete(this.state, version);
      if (this.state.phase !== "ACTIVE" || this.state.generation !== next.generation || this.state.secretVersion !== version || this.state.attemptId !== null) throw new ConsoleSyncError("OAUTH_STATE_READBACK_MISMATCH");
      await this.assertCurrent();
      this.credential = readback; this.accessToken = readback.accessToken; this.expiresAt = readback.expiresAt!;
    } catch { this.stopped = "OAUTH_GRANT_PRESERVATION_FAILED"; throw new ConsoleSyncError(this.stopped); }
  }
  async fetch(input: string | URL | Request, init?: RequestInit) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== MCP_URL) throw new ConsoleSyncError("MCP_HOST_NOT_ALLOWED");
    if (this.stopped) throw new ConsoleSyncError(this.stopped);
    if (!this.accessToken || this.expiresAt <= Date.now() + 30_000) await this.refresh(init?.signal ?? undefined);
    const send = async () => {
      if (this.refreshing) await this.refreshing;
      await this.assertCurrent();
      if (this.state.phase !== "ACTIVE") throw new ConsoleSyncError("OAUTH_REFRESH_IN_FLIGHT");
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
