import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { verifyDiscordSignature, verifyGrafanaSignature } from "@/lib/discord/security";

test("Discord Ed25519 서명을 검증하고 오래된 요청을 거부한다", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const body = JSON.stringify({ type: 1 });
  const now = new Date("2026-08-18T00:00:00.000Z");
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeyHex = publicDer.subarray(publicDer.length - 32).toString("hex");

  assert.equal(verifyDiscordSignature({ body, signature, timestamp, publicKey: publicKeyHex, now }), true);
  assert.equal(verifyDiscordSignature({ body: body + " ", signature, timestamp, publicKey: publicKeyHex, now }), false);
  assert.equal(verifyDiscordSignature({ body, signature, timestamp, publicKey: publicKeyHex, now: new Date(now.getTime() + 301_000) }), false);
});

test("Grafana 공식 timestamp:body HMAC 형식을 검증한다", () => {
  const body = JSON.stringify({ status: "firing" });
  const secret = "test-only-secret";
  const timestamp = "1787011200";
  const signature = createHmac("sha256", secret).update(`${timestamp}:${body}`).digest("hex");
  const now = new Date(Number(timestamp) * 1_000);

  assert.equal(verifyGrafanaSignature({ body, signature, timestamp, secret, now }), true);
  assert.equal(verifyGrafanaSignature({ body: body + " ", signature, timestamp, secret, now }), false);
  assert.equal(verifyGrafanaSignature({ body, signature, timestamp, secret, now: new Date(now.getTime() + 301_000) }), false);
});
