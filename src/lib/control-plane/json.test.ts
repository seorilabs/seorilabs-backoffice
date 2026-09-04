import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, contractCanonicalJson } from "@/lib/control-plane/json";

test("계약 정규화는 locale이 아니라 code unit 순서를 쓴다", () => {
  // 중앙 WorkflowBundle 구현이 기본 sort를 쓰므로 대문자가 먼저 온다. localeCompare는
  // 이 둘의 순서를 뒤집어 digest가 갈라진다.
  const value = { builderImage: "b", buildProfile: "p" };
  assert.equal(contractCanonicalJson(value), '{"buildProfile":"p","builderImage":"b"}');
  assert.notEqual(contractCanonicalJson(value), canonicalJson(value));
});

test("계약 정규화는 중첩과 배열을 따라가고 유한하지 않은 숫자를 거부한다", () => {
  assert.equal(contractCanonicalJson({ b: [{ z: 1, a: 2 }] }), '{"b":[{"a":2,"z":1}]}');
  assert.throws(() => contractCanonicalJson({ n: Number.POSITIVE_INFINITY } as never));
});
