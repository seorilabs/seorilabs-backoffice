import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(
  join(process.cwd(), "src/lib/notifications/outbox.ts"),
  "utf8",
);

test("기존 event 재수집은 새 provider 목적지를 역으로 추가하지 않는다", () => {
  assert.match(source, /create:\s*input\.destinations\.map/);
  assert.match(source, /update:\s*\{ payload: input\.payload \}/);
  assert.doesNotMatch(source, /prisma\.notificationDelivery\.upsert/);
});
