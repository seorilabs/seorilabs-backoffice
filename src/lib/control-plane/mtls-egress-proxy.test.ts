import assert from "node:assert/strict";
import test from "node:test";

import {
  exactHostSet,
  exactPeerSpiffeIdentity,
  exactSpiffeSet,
  isPublicConnectAddress,
  parseConnectAuthority,
  readBoundedResponseBody,
  resolvePublicConnectAddress,
} from "./mtls-egress-proxy";

test("exact allowlists reject duplicates, IP literals, and malformed identities", () => {
  assert.deepEqual([...exactHostSet("api.github.com,backoffice.vzyx.xyz")], [
    "api.github.com",
    "backoffice.vzyx.xyz",
  ]);
  assert.throws(() => exactHostSet("api.github.com,api.github.com"));
  assert.throws(() => exactHostSet("127.0.0.1"));
  assert.throws(() => exactHostSet("api.github.com,"));

  const identities = exactSpiffeSet([
    "spiffe://seorilabs.local/ns/auth-broker/sa/seori-auth-agent-runtime",
    "spiffe://seorilabs.local/ns/auth-broker/sa/workflow-bundle-candidate-executor",
  ].join(","));
  assert.equal(identities.size, 2);
  assert.throws(() => exactSpiffeSet("spiffe://look-alike.invalid/ns/auth-broker/sa/runtime"));
});

test("CONNECT is exact host and port 443 only", () => {
  const allowed = exactHostSet("api.github.com,backoffice.vzyx.xyz");
  assert.deepEqual(parseConnectAuthority("api.github.com:443", allowed), {
    hostname: "api.github.com",
    port: 443,
  });
  assert.throws(() => parseConnectAuthority("api.github.com:80", allowed));
  assert.throws(() => parseConnectAuthority("api.github.com.evil.test:443", allowed));
  assert.throws(() => parseConnectAuthority("user@api.github.com:443", allowed));
  assert.throws(() => parseConnectAuthority("127.0.0.1:443", allowed));
});

test("private, loopback, documentation, mapped, and multicast addresses are rejected", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
  ]) assert.equal(isPublicConnectAddress(address, 4), false, address);
  assert.equal(isPublicConnectAddress("20.200.245.245", 4), true);
  for (const address of ["::", "::1", "fc00::1", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicConnectAddress(address, 6), false, address);
  }
  assert.equal(isPublicConnectAddress("2606:50c0:8000::154", 6), true);
});

test("DNS rebinding is rejected when any answer is non-public", async () => {
  const lookup = (async () => [
    { address: "20.200.245.245", family: 4 as const },
    { address: "127.0.0.1", family: 4 as const },
  ]) as never;
  await assert.rejects(resolvePublicConnectAddress("api.github.com", lookup));
  const publicLookup = (async () => [
    { address: "20.200.245.245", family: 4 as const },
    { address: "20.200.245.246", family: 4 as const },
  ]) as never;
  assert.deepEqual(await resolvePublicConnectAddress("api.github.com", publicLookup), {
    address: "20.200.245.245",
    family: 4,
  });
});

test("mTLS peer must present exactly one allowed SPIFFE URI SAN", () => {
  const allowed = exactSpiffeSet("spiffe://seorilabs.local/ns/auth-broker/sa/seori-auth-agent-runtime");
  assert.equal(
    exactPeerSpiffeIdentity(
      "URI:spiffe://seorilabs.local/ns/auth-broker/sa/seori-auth-agent-runtime",
      allowed,
    ),
    "spiffe://seorilabs.local/ns/auth-broker/sa/seori-auth-agent-runtime",
  );
  assert.throws(() => exactPeerSpiffeIdentity("DNS:api.github.com", allowed));
  assert.throws(() => exactPeerSpiffeIdentity(
    "URI:spiffe://seorilabs.local/ns/auth-broker/sa/seori-auth-agent-runtime, URI:spiffe://seorilabs.local/ns/auth-broker/sa/other",
    allowed,
  ));
});

test("chunked response도 선언 길이와 무관하게 상한에서 중단한다", async () => {
  const accepted = await readBoundedResponseBody(
    new Response("1234"),
    4,
    "TEST_RESPONSE_TOO_LARGE",
  );
  try {
    assert.equal(accepted.toString("utf8"), "1234");
  } finally {
    accepted.fill(0);
  }

  await assert.rejects(
    readBoundedResponseBody(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("123"));
          controller.enqueue(new TextEncoder().encode("45"));
          controller.close();
        },
      })),
      4,
      "TEST_RESPONSE_TOO_LARGE",
    ),
    /TEST_RESPONSE_TOO_LARGE/u,
  );
  await assert.rejects(
    readBoundedResponseBody(
      new Response("12345", { headers: { "content-length": "5" } }),
      4,
      "TEST_RESPONSE_TOO_LARGE",
    ),
    /TEST_RESPONSE_TOO_LARGE/u,
  );
});
