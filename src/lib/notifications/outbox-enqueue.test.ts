import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isTerminalFailure } from "@/lib/notifications/outbox";

const source = readFileSync(
  join(process.cwd(), "src/lib/notifications/outbox.ts"),
  "utf8",
);

test("기존 event 재수집은 새 provider 목적지를 역으로 추가하지 않는다", () => {
  assert.match(source, /create:\s*input\.destinations\.map/);
  assert.match(source, /update:\s*\{ payload: input\.payload \}/);
  assert.doesNotMatch(source, /prisma\.notificationDelivery\.upsert/);
});

test("재시도로 풀리지 않는 실패는 즉시 dead letter 로 본다", () => {
  // 권한 부족처럼 설정을 고쳐야 풀리는 실패를 10회씩 재시도하면 원인이 묻히고
  // 이벤트마다 실패 행이 10배로 쌓인다.
  assert.equal(isTerminalFailure({ terminal: true }, 1, 10), true, "첫 시도라도 terminal 이면 종료");
  assert.equal(isTerminalFailure({}, 1, 10), false, "일반 실패는 재시도");
  assert.equal(isTerminalFailure({}, 9, 10), false);
  assert.equal(isTerminalFailure({}, 10, 10), true, "상한에 닿으면 종료");
  assert.equal(isTerminalFailure({ terminal: false }, 3, 10), false);
});
