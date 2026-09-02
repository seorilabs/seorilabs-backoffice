import assert from "node:assert/strict";
import test from "node:test";

import { readGitHubAppPublicSource } from "@/lib/github/app-public-source";

const NOW = new Date("2026-09-02T01:20:00.000Z");
const WEBHOOK_URL = "https://backoffice.vzyx.xyz/api/webhooks";
const DELIVERY_ID = 3840370713686974464n;
const CANARY = "fixture-secret-must-never-escape";

function fixture() {
  const app = {
    id: 4124446, slug: "seorilabs-backoffice", owner: { id: 283115031, login: "seorilabs" },
    updated_at: "2026-09-01T15:44:47Z", permissions: { contents: "read", metadata: "read" },
    events: ["repository", "push"], client_secret: CANARY,
  };
  const installation = {
    id: 142120077, app_id: app.id, target_id: app.owner.id, target_type: "Organization",
    account: { ...app.owner }, repository_selection: "all", permissions: app.permissions, events: app.events,
    updated_at: "2026-09-01T15:45:41.000Z", suspended_at: null as string | null,
  };
  const hook = { url: WEBHOOK_URL, content_type: "json", insecure_ssl: "0", secret: CANARY };
  const delivery = {
    id: DELIVERY_ID, guid: "578d8fd0-a66c-11f1-8aef-d8942d2010d9", event: "workflow_run",
    delivered_at: "2026-09-02T01:19:30.291Z", status_code: 200, installation_id: installation.id,
    repository_id: 1249074926,
  };
  const detail = {
    ...delivery, url: WEBHOOK_URL,
    request: { headers: { authorization: CANARY }, payload: { sensitive: CANARY } },
    response: { payload: CANARY },
  };
  const state = { app, installation, hook, deliveries: [delivery], detail };
  const calls: { route: string; parameters: Record<string, unknown> }[] = [];
  const client = {
    async request(route: string, parameters: Record<string, unknown> = {}) {
      assert.ok(route.startsWith("GET "));
      assert.deepEqual(parameters.headers, { "X-GitHub-Api-Version": "2026-03-10" });
      const request = parameters.request as { redirect?: string; signal?: AbortSignal };
      assert.equal(request.redirect, "error");
      assert.ok(request.signal instanceof AbortSignal);
      calls.push({ route, parameters });
      if (route === "GET /app") return { data: state.app };
      if (route === "GET /orgs/{org}/installation") {
        assert.equal(parameters.org, "seorilabs");
        return { data: state.installation };
      }
      if (route === "GET /app/hook/config") return { data: state.hook };
      if (route === "GET /app/hook/deliveries") {
        assert.equal(parameters.per_page, 100);
        return { data: state.deliveries };
      }
      if (route === "GET /app/hook/deliveries/{delivery_id}") {
        assert.equal(parameters.delivery_id, String(DELIVERY_ID));
        return { data: state.detail };
      }
      throw new Error("UNEXPECTED_REQUEST");
    },
  };
  return { state, calls, client, read: () => readGitHubAppPublicSource(client, "seorilabs", () => NOW) };
}

test("official App and webhook responses work without a fictional hook_config.active field", async () => {
  const { read, calls } = fixture();
  const source = await read();
  assert.equal(source.app.webhookActive, true);
  assert.equal(source.app.active, true);
  assert.equal(source.app.webhookUrl, WEBHOOK_URL);
  assert.equal(source.installation.updatedAt, "2026-09-01T15:45:41.000Z");
  assert.equal(source.observedAt, NOW.toISOString());
  assert.deepEqual(Object.keys(source).sort(), ["app", "installation", "observedAt"]);
  assert.equal(calls.length, 5);
  assert.doesNotMatch(JSON.stringify(source), /fixture-secret|authorization|payload|client_secret|hook_config/u);
});

test("installed Octokit preserves provider delivery IDs larger than the JS safe-integer limit", async () => {
  const { Octokit } = await import("octokit");
  const { state } = fixture();
  const requested: string[] = [];
  const stringify = (value: unknown) => JSON.stringify(value, (_key, child) => typeof child === "bigint" ? String(child) : child)
    .replaceAll(`"${DELIVERY_ID}"`, String(DELIVERY_ID));
  const client = new Octokit({ request: { fetch: async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    requested.push(url.pathname);
    const responses: Record<string, unknown> = {
      "/app": state.app, "/orgs/seorilabs/installation": state.installation,
      "/app/hook/config": state.hook, "/app/hook/deliveries": state.deliveries,
      [`/app/hook/deliveries/${DELIVERY_ID}`]: state.detail,
    };
    assert.ok(Object.hasOwn(responses, url.pathname), "detail URL must not use a rounded ID");
    return new Response(stringify(responses[url.pathname]), { headers: { "content-type": "application/json" } });
  } } });
  const source = await readGitHubAppPublicSource(client, "seorilabs", () => NOW);
  assert.equal(source.app.webhookActive, true);
  assert.ok(requested.includes(`/app/hook/deliveries/${DELIVERY_ID}`));
});

test("configured URL alone, no deliveries, and another installation never prove working delivery", async () => {
  for (const configure of [
    (f: ReturnType<typeof fixture>) => { f.state.deliveries = []; },
    (f: ReturnType<typeof fixture>) => { f.state.deliveries[0].installation_id = 1; },
    (f: ReturnType<typeof fixture>) => { f.state.hook.insecure_ssl = "1"; },
    (f: ReturnType<typeof fixture>) => { f.state.hook.content_type = "form"; },
  ]) {
    const f = fixture(); configure(f);
    assert.equal((await f.read()).app.webhookActive, false);
    assert.ok(!f.calls.some(({ route }) => route.endsWith("{delivery_id}")));
  }
});

test("failed, redirected, stale, future, and pre-configuration deliveries are not accepted", async () => {
  for (const patch of [
    { status_code: 500 }, { status_code: 301 }, { status_code: 202.5 },
    { delivered_at: "2026-09-02T01:04:59Z" },
    { delivered_at: "2026-09-02T01:20:01Z" },
    { delivered_at: "2026-09-01T15:40:00Z" },
  ]) {
    const f = fixture(); Object.assign(f.state.deliveries[0], patch);
    assert.equal((await f.read()).app.webhookActive, false);
  }
  const f = fixture();
  f.state.deliveries.push({ ...f.state.deliveries[0], id: DELIVERY_ID + 1n, status_code: 500 });
  assert.equal((await f.read()).app.webhookActive, false, "an older success cannot hide the newest failure");
});

test("detail URL, status, identity, timestamp, and exact delivery ID must agree with the listing", async () => {
  for (const patch of [
    { url: "https://backoffice.vzyx.xyz.attacker.invalid/api/webhooks" },
    { status_code: 302 }, { installation_id: 1 }, { repository_id: 2 },
    { guid: "other-delivery" }, { event: "push" },
    { delivered_at: "2026-09-02T01:19:31Z" }, { id: DELIVERY_ID + 1n },
  ]) {
    const f = fixture(); Object.assign(f.state.detail, patch);
    assert.equal((await f.read()).app.webhookActive, false);
  }
});

test("revoked installation cannot claim an active App or use previous successful deliveries", async () => {
  const f = fixture(); f.state.installation.suspended_at = "2026-09-02T01:19:50Z";
  const source = await f.read();
  assert.equal(source.app.active, false);
  assert.equal(source.app.webhookActive, false);
  assert.equal(source.installation.suspended, true);
  assert.equal(f.calls.length, 3);
});

test("invalid identities, unsafe URL components, and malformed or rounded IDs fail closed", async () => {
  for (const configure of [
    (f: ReturnType<typeof fixture>) => { f.state.app.id = 1; },
    (f: ReturnType<typeof fixture>) => { f.state.app.owner.login = "other-org"; },
    (f: ReturnType<typeof fixture>) => { f.state.app.updated_at = "invalid"; },
    (f: ReturnType<typeof fixture>) => { f.state.hook.url = `https://user:${CANARY}@example.invalid/webhook`; },
    (f: ReturnType<typeof fixture>) => { f.state.hook.url = `https://example.invalid/webhook?key=${CANARY}`; },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.state.deliveries[0], { id: Number(DELIVERY_ID) }); },
  ]) {
    const f = fixture(); configure(f);
    await assert.rejects(f.read, (error: Error) => {
      assert.equal(error.message, "GITHUB_APP_PUBLIC_STATE_READ_FAILED");
      assert.doesNotMatch(error.stack ?? "", /fixture-secret/u);
      return true;
    });
  }
});

test("provider errors never leak request headers or secrets through the public readback", async () => {
  await assert.rejects(readGitHubAppPublicSource({ request: async () => { throw new Error(CANARY); } }, "seorilabs"),
    (error: Error) => error.message === "GITHUB_APP_PUBLIC_STATE_READ_FAILED" && !JSON.stringify(error).includes(CANARY));
});
