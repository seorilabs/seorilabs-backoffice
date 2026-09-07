import assert from "node:assert/strict";
import test from "node:test";

import { resolvePlatformOccurrenceReuse } from "@/lib/control-plane/platform-fleet-occurrence-reuse";

const DEFINITION = "definition-1";
const WORK_KEY = "platform:c0d7b0c4:1265192029";

function resolve(runs: Array<{ workKey: string | null }>, overrides: { definitionId?: string } = {}) {
  return resolvePlatformOccurrenceReuse({
    occurrenceDefinitionId: overrides.definitionId ?? DEFINITION,
    expectedDefinitionId: DEFINITION,
    runs,
    workKey: WORK_KEY,
  });
}

test("같은 workKey를 쥔 run이 있으면 그 run을 재사용한다", () => {
  assert.deepEqual(resolve([{ workKey: WORK_KEY }]), { kind: "REUSE_RUN", index: 0 });
  assert.deepEqual(
    resolve([{ workKey: null }, { workKey: WORK_KEY }]),
    { kind: "REUSE_RUN", index: 1 },
  );
});

test("superseded 계획만 남았으면 occurrence를 재사용해 새 run을 만든다", () => {
  // 계획이 superseded 되면 run을 닫고 workKey를 비운다. 이 상태에서 거부하면
  // 같은 릴리스·앱의 producer가 영구히 409로 멈춘다.
  assert.deepEqual(resolve([{ workKey: null }]), { kind: "CREATE_RUN" });
  assert.deepEqual(resolve([{ workKey: null }, { workKey: null }]), { kind: "CREATE_RUN" });
});

test("run이 하나도 없는 occurrence도 새 run을 만든다", () => {
  assert.deepEqual(resolve([]), { kind: "CREATE_RUN" });
});

test("다른 workKey를 쥔 run이 남아 있으면 fail-closed한다", () => {
  assert.deepEqual(resolve([{ workKey: "platform:other:999" }]), { kind: "CONFLICT" });
  assert.deepEqual(
    resolve([{ workKey: null }, { workKey: "platform:other:999" }]),
    { kind: "CONFLICT" },
    "해제된 run이 섞여 있어도 살아 있는 다른 work가 우선한다",
  );
});

test("occurrence가 다른 definition에 속하면 fail-closed한다", () => {
  assert.deepEqual(resolve([{ workKey: WORK_KEY }], { definitionId: "definition-2" }), { kind: "CONFLICT" });
  assert.deepEqual(resolve([{ workKey: null }], { definitionId: "definition-2" }), { kind: "CONFLICT" });
});
