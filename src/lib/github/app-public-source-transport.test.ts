import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import test from "node:test";

test("운영 App 공개 조회도 전달받은 제한 fetch만 사용하고 기본 network를 사용하지 않는다", async () => {
  const program = String.raw`
    const { generateKeyPairSync } = require("node:crypto");
    globalThis.fetch = async () => { throw new Error("DEFAULT_NETWORK_FORBIDDEN"); };
    process.env.GITHUB_APP_ID = "4124446";
    process.env.GITHUB_ORG = "seorilabs";
    process.env.GITHUB_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" });
    (async () => {
      const { readFleetGitHubAppPublicSource } = await import("./src/lib/github/app.ts");
      const { createFleetP7RequestFetch } = await import("./src/lib/control-plane/fleet-p7-scoped-read-client.ts");
      const observed = [];
      const updated = new Date(Date.now() - 60000).toISOString();
      const owner = { id: 283115031, login: "seorilabs" };
      const permissions = { metadata: "read", contents: "read" };
      const responses = {
        "/app": { id: 4124446, slug: "seorilabs-backoffice", owner, updated_at: updated, permissions, events: ["repository", "push"] },
        "/orgs/seorilabs/installation": { id: 142120077, app_id: 4124446, target_id: owner.id, target_type: "Organization",
          account: owner, repository_selection: "all", permissions, events: ["repository", "push"], updated_at: updated, suspended_at: null },
        "/app/hook/config": { url: "https://backoffice.vzyx.xyz/api/webhooks", content_type: "json", insecure_ssl: "0" },
        "/app/hook/deliveries": [],
      };
      const transport = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (!Object.hasOwn(responses, url.pathname) || url.origin !== "https://api.github.com"
          || init.redirect !== "error" || !(init.signal instanceof AbortSignal)
          || !new Headers(init.headers).has("authorization")) throw new Error("TRANSPORT_NOT_BOUND");
        observed.push(url.pathname);
        return new Response(JSON.stringify(responses[url.pathname]), { headers: { "content-type": "application/json" } });
      };
      const source = await readFleetGitHubAppPublicSource({ requestFetch: createFleetP7RequestFetch(transport) });
      process.stdout.write(JSON.stringify({ appId: source.app.id, routes: observed.sort() }));
    })().catch(() => { process.stderr.write("FIXTURE_PUBLIC_READ_FAILED\n"); process.exitCode = 1; });
  `;
  const bundle = await build({
    stdin: { contents: program, resolveDir: process.cwd(), sourcefile: "app-public-transport-fixture.ts", loader: "ts" },
    write: false, bundle: true, platform: "node", format: "cjs", target: "node24", alias: { "@": "./src" },
  });
  const result = spawnSync(process.execPath, ["--input-type=commonjs"], {
    input: bundle.outputFiles[0].text, encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH, NODE_ENV: "test" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    appId: "4124446", routes: ["/app", "/app/hook/config", "/app/hook/deliveries", "/orgs/seorilabs/installation"],
  });
  assert.doesNotMatch(result.stdout, /PRIVATE KEY|authorization|Bearer/iu);
});
