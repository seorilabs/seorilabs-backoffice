import assert from "node:assert/strict";
import test from "node:test";
import {
  closeCodeAction,
  initialHeartbeatDelay,
  nextBackoffMs,
  parseGatewayPayload,
} from "@/lib/discord/gateway";

test("인증 실패와 intent 오류 close code 는 재접속하지 않는다", () => {
  assert.equal(closeCodeAction(4004), "fatal");
  for (const code of [4010, 4011, 4012, 4013, 4014]) {
    assert.equal(closeCodeAction(code), "fatal");
  }
});

test("잘못된 seq 와 세션 만료는 세션을 버리고 재식별한다", () => {
  assert.equal(closeCodeAction(4007), "identify");
  assert.equal(closeCodeAction(4009), "identify");
});

test("일반 종료는 RESUME 을 시도한다", () => {
  assert.equal(closeCodeAction(4000), "resume");
  assert.equal(closeCodeAction(1006), "resume");
  assert.equal(closeCodeAction(undefined), "resume");
});

test("재접속 backoff 는 지수 증가하고 60초에서 멈춘다", () => {
  assert.equal(nextBackoffMs(0), 1_000);
  assert.equal(nextBackoffMs(1), 2_000);
  assert.ok(nextBackoffMs(3) > nextBackoffMs(2));
  assert.equal(nextBackoffMs(6), 60_000);
  assert.equal(nextBackoffMs(100), 60_000);
});

test("첫 heartbeat 지연은 jitter 를 0~interval 로 제한한다", () => {
  assert.equal(initialHeartbeatDelay(40_000, 0), 0);
  assert.equal(initialHeartbeatDelay(40_000, 0.5), 20_000);
  assert.equal(initialHeartbeatDelay(40_000, 1), 40_000);
  assert.equal(initialHeartbeatDelay(40_000, 2), 40_000);
  assert.equal(initialHeartbeatDelay(40_000, -1), 0);
});

test("Gateway payload 파서는 op 없는 JSON 과 비 문자열을 거른다", () => {
  assert.deepEqual(parseGatewayPayload('{"op":10,"d":{"heartbeat_interval":41250}}'), {
    op: 10,
    d: { heartbeat_interval: 41_250 },
  });
  const dispatch = parseGatewayPayload('{"op":0,"t":"MESSAGE_CREATE","s":42,"d":{}}');
  assert.equal(dispatch?.t, "MESSAGE_CREATE");
  assert.equal(dispatch?.s, 42);
  assert.equal(parseGatewayPayload("not json"), null);
  assert.equal(parseGatewayPayload('{"t":"READY"}'), null);
  assert.equal(parseGatewayPayload(Buffer.from("{}")), null);
  assert.equal(parseGatewayPayload(null), null);
});
