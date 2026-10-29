import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "./security";

test("Slack 서명은 원문과 시각을 함께 검증한다", () => {
  const body = "command=%2Fhelp&team_id=T123";
  const timestamp = "1793260000";
  const secret = "test-signing-secret";
  const signature = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  const input = { body, timestamp, signature, secret, now: Number(timestamp) * 1000 };
  assert.equal(verifySlackSignature(input), true);
  assert.equal(verifySlackSignature({ ...input, body: body + "x" }), false);
  assert.equal(verifySlackSignature({ ...input, now: input.now + 301000 }), false);
  assert.equal(verifySlackSignature({ ...input, signature: "v0=bad" }), false);
  assert.equal(verifySlackSignature({ ...input, secret: "" }), false);
});
