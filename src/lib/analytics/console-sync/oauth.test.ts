import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleOAuth, MCP_URL, TOKEN_URL, loadConsoleCredential, consoleErrorCode } from "./oauth";
const credential = { credentialId: "shared/apps-in-toss/console-oauth", clientId: "mcp-gateway" as const, refreshToken: "synthetic-refresh" };
const token = () => Response.json({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 });
test("만료 토큰은 한 번 갱신하고 재시작도 등록 refresh를 재사용한다", async () => {
  let refreshes = 0; let reads = 0;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, "error");
    if (url === TOKEN_URL) { refreshes++; const params = init?.body as URLSearchParams; assert.equal(params.get("grant_type"), "refresh_token"); return token(); }
    assert.equal(url, MCP_URL); reads++; assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-access"); return Response.json({ ok: true });
  };
  const oauth = new ConsoleOAuth({ ...credential, accessToken: "expired", expiresAt: 1 }, fetcher);
  await Promise.all([oauth.fetch(MCP_URL), oauth.fetch(MCP_URL)]); assert.equal(refreshes, 1); assert.equal(reads, 2);
  await new ConsoleOAuth(credential, fetcher).fetch(MCP_URL); assert.equal(refreshes, 2);
});
test("401 재시도는 한 번이며 invalid_grant·권한 상실은 연결을 멈춘다", async () => {
  let refreshes = 0; let reads = 0;
  const oauth = new ConsoleOAuth(credential, async (url) => url === TOKEN_URL ? (refreshes++, token()) : (reads++, new Response(null, { status: 401 })));
  await assert.rejects(oauth.fetch(MCP_URL), /REAUTHENTICATION_REQUIRED/);
  await assert.rejects(oauth.fetch(MCP_URL), /REAUTHENTICATION_REQUIRED/); assert.equal(reads, 2); assert.equal(refreshes, 2);
  let invalid = 0;
  const revoked = new ConsoleOAuth(credential, async () => { invalid++; return Response.json({ error: "invalid_grant", secret: "do-not-output" }, { status: 400 }); });
  await assert.rejects(revoked.refresh(), /REAUTHENTICATION_REQUIRED/); await assert.rejects(revoked.refresh(), /REAUTHENTICATION_REQUIRED/); assert.equal(invalid, 1);
});
test("refresh rotation은 저장하지 않고 즉시 멈춘다", async () => {
  const oauth = new ConsoleOAuth(credential, async () => Response.json({ access_token: "synthetic-access", token_type: "bearer", expires_in: 3600, refresh_token: "rotated-secret" }));
  await assert.rejects(oauth.refresh(), /OAUTH_ROTATION_REQUIRES_REVIEW/); assert.equal(credential.refreshToken, "synthetic-refresh");
  await assert.rejects(oauth.fetch(MCP_URL), /OAUTH_ROTATION_REQUIRES_REVIEW/);
});
test("고정 주소 밖으로 인증을 보내지 않고 오류 원문을 보고하지 않는다", async () => {
  let calls = 0; const oauth = new ConsoleOAuth(credential, async () => { calls++; throw new Error("synthetic-secret"); });
  await assert.rejects(oauth.fetch("https://example.com"), /MCP_HOST_NOT_ALLOWED/); assert.equal(calls, 0);
  try { await oauth.refresh(); } catch (e) { assert.equal(consoleErrorCode(e), "OAUTH_REFRESH_NETWORK_ERROR"); assert.ok(!JSON.stringify(e).includes("synthetic-secret")); }
});
test("자격증명 논리 ID·파일 권한을 검증하고 원본은 변경하지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ait-credential-test-")); const file = join(dir, "credential.json"); const raw = JSON.stringify(credential);
  try {
    await writeFile(file, raw, { mode: 0o600 }); assert.deepEqual(await loadConsoleCredential(file, credential.credentialId), credential);
    await assert.rejects(loadConsoleCredential(file, "shared/apps-in-toss/other"), /OAUTH_IDENTITY_MISMATCH/);
    await chmod(file, 0o644); await assert.rejects(loadConsoleCredential(file, credential.credentialId), /OAUTH_FILE_NOT_PRIVATE/);
    assert.equal(await readFile(file, "utf8"), raw); await assert.rejects(loadConsoleCredential(), /OAUTH_CREDENTIAL_REQUIRED/);
  } finally { await rm(dir, { recursive: true }); }
});
test("불완전한 갱신 응답의 회전도 먼저 감지해 옛 토큰 재사용을 멈춘다", async () => {
  let calls = 0;
  const oauth = new ConsoleOAuth(credential, async () => { calls++; return Response.json({ refresh_token: "rotated-secret", access_token: "new" }); });
  await assert.rejects(oauth.refresh(), /OAUTH_ROTATION_REQUIRES_REVIEW/);
  await assert.rejects(oauth.refresh(), /OAUTH_ROTATION_REQUIRES_REVIEW/); assert.equal(calls, 1);
});
test("인가 설정 오류는 재로그인과 구분하고 응답 원문을 남기지 않는다", async () => {
  for (const [error, code] of [["invalid_client", "OAUTH_CLIENT_CONFIGURATION_INVALID"], ["invalid_target", "OAUTH_RESOURCE_CONFIGURATION_INVALID"], ["unsupported_grant_type", "OAUTH_REFRESH_NOT_SUPPORTED"]]) {
    const oauth = new ConsoleOAuth(credential, async () => Response.json({ error, description: "synthetic-secret" }, { status: 400 }));
    await assert.rejects(oauth.refresh(), new RegExp(code)); assert.equal(oauth.failureCode, code);
  }
});
