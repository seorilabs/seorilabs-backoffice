import assert from "node:assert/strict";
import test from "node:test";
import { isUnreusableCard } from "@/lib/notifications/deploy";

test("사람이 지운 카드는 편집을 포기하고 새로 보낸다", () => {
  assert.equal(isUnreusableCard({ statusCode: 404, errorCode: 10_008 }), true);
});

test("다른 봇 정체가 올린 카드도 이어 쓸 수 없다", () => {
  // 실측: slotmachine untagged PLAY 카드가 "Cannot edit a message authored by
  // another user"(403)로 10회 재시도 끝에 dead letter 4건이 됐다. 재시도로 풀리지
  // 않으므로 새 카드를 보내야 갱신이 이어진다.
  assert.equal(isUnreusableCard({ statusCode: 403 }), true);
});

test("일시적 실패는 이어 쓰기를 포기하지 않는다", () => {
  // 새 카드를 보내면 채널에 중복 카드가 쌓인다. 기다리면 풀리는 실패는 재시도한다.
  for (const result of [{ statusCode: 429 }, { statusCode: 500 }, { statusCode: 502 }, {}]) {
    assert.equal(isUnreusableCard(result), false, JSON.stringify(result));
  }
  // 404 라도 "메시지 없음"(10008)이 아니면 다른 원인이다.
  assert.equal(isUnreusableCard({ statusCode: 404, errorCode: 10_003 }), false);
});
