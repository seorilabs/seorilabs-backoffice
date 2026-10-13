import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

// 실제 CLI·MCP HTTP·매핑을 실행한다. DB와 운영 자격증명 경계만 격리한다.
async function executeCollector(storageFailure: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), "console-collector-test-"));
  const entry = path.resolve("scripts/console-metrics-collector.ts");
  const output = path.join(directory, "collector.cjs");
  const trace = path.join(directory, "trace.json");
  const event = `const events = globalThis.__collectorEvents ??= [];`;
  const mocks: Record<string, string> = {
    prisma: `${event}
      import { writeFile } from 'node:fs/promises';
      export const prisma = { async $disconnect() {
        events.push('disconnect'); await globalThis.__collectorFixture?.close();
        await writeFile(process.env.CONSOLE_COLLECTOR_TEST_TRACE, JSON.stringify(events));
      }};`,
    oauth: `export const MCP_URL = 'https://mcp.toss.im/adapters/apps-in-toss-console/mcp';
      export const TOKEN_URL = 'https://business-accounts.toss.im/oauth2/token';
      export class ConsoleSyncError extends Error { constructor(code) { super(code); this.code = code; } }
      export function consoleErrorCode(e) { return e instanceof ConsoleSyncError ? e.code : 'CONSOLE_REQUEST_FAILED'; }
      export class ConsoleOAuth { static async open(versions) { return {
        fetch(input, init) { const headers = new Headers(init?.headers); headers.set('Authorization', 'Bearer fixture-access'); return versions.fetcher(input, {...init, headers}); }
      }; } }`,
    versions: `import { startConsoleFixture } from ${JSON.stringify(path.resolve("scripts/console-metrics/fixture-server.ts"))};
      export class SecretManagerConsoleGrantVersions { static async fromWif() {
        return globalThis.__collectorFixture = await startConsoleFixture();
      } }`,
    runtime: `export function consoleRuntimeLedger() { return {}; }`,
    client: `${event}
      import { createConsoleReader as connect } from ${JSON.stringify(path.resolve("src/lib/analytics/console-sync/client.ts"))};
      export async function createConsoleReader(oauth) { const reader = await connect(oauth); return {
        call: (...args) => reader.call(...args),
        async close() { events.push('close'); await reader.close(); }
      }; }`,
    collect: `${event}
      import { ConsoleSyncError } from ${JSON.stringify(path.resolve("src/lib/analytics/console-sync/oauth.ts"))};
      export async function withConsoleCollectionLock(run) { return run(async () => {}); }
      export async function collectConsoleMetrics(source) {
        events.push('collection-start');
        // 실제 수집의 상태 조회처럼 연결 생성 뒤 비동기 DB 응답을 기다린다.
        await new Promise(resolve => setTimeout(resolve, 30));
        const response = await source.queryListing({slug:'lizard-tycoon',workspaceId:38345,miniAppId:61736}, '2026-10-11', '2026-10-11');
        events.push('query-finished');
        if (${storageFailure}) { events.push('storage-failed'); throw new ConsoleSyncError('STORAGE_FAILED'); }
        const state = response.days.length === 1 && response.errors.length === 0 ? 'complete' : 'partial';
        events.push('collection-finished'); return {state, upserts:response.days.length, errors:response.errors};
      }`,
  };
  try {
    await build({
      entryPoints: [entry], outfile: output, bundle: true, platform: "node", format: "cjs", target: "node24",
      alias: { "@": path.resolve("src") }, logLevel: "silent",
      plugins: [{ name: "isolated-collector-boundaries", setup(builder) {
        builder.onResolve({ filter: /./ }, (args) => {
          let key: string | undefined;
          const modulePath = args.path.replace(/\.ts$/, "");
          if (modulePath.endsWith("/prisma")) key = "prisma";
          if (modulePath.endsWith("/console-sync/oauth") || modulePath === "./oauth") key = "oauth";
          if (modulePath.endsWith("/console-sync/versions")) key = "versions";
          if (modulePath.endsWith("/control-plane/console-oauth-runtime")) key = "runtime";
          if (modulePath.endsWith("/console-sync/collect")) key = "collect";
          if (args.importer === entry && modulePath.endsWith("/console-sync/client")) key = "client";
          return key ? { path: key, namespace: "collector-test" } : undefined;
        });
        builder.onLoad({ filter: /.*/, namespace: "collector-test" }, (args) => ({ contents: mocks[args.path], loader: "js", resolveDir: process.cwd() }));
      }}],
    });
    const child = spawn(process.execPath, [output, "collect"], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", AIT_CONSOLE_CREDENTIAL_ID: "shared/apps-in-toss/console-oauth", CONSOLE_COLLECTOR_TEST_TRACE: trace },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    }).finally(() => clearTimeout(timer));
    return { exitCode, stdout, stderr, events: JSON.parse(await readFile(trace, "utf8")) as string[] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("수집 CLI가 지연 조회와 저장 완료 뒤 MCP 연결을 닫는다", async () => {
  const result = await executeCollector(false);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { state: "complete", upserts: 1, errors: [] });
  assert.deepEqual(result.events, ["collection-start", "query-finished", "collection-finished", "close", "disconnect"]);
});

test("수집 CLI가 비동기 저장 실패에도 연결을 한 번 닫고 DB를 해제한다", async () => {
  const result = await executeCollector(true);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stderr), { state: "failed", code: "STORAGE_FAILED" });
  assert.deepEqual(result.events, ["collection-start", "query-finished", "storage-failed", "close", "disconnect"]);
});
