import assert from "node:assert/strict";
import { test } from "node:test";

import { resumePreparedSandboxResetWhenPrepared } from "@/lib/actions/platform-ops-policy";
import type { PlatformSandboxResetRemoteState } from "@/lib/platform/runs";

test("sandbox reset 재개 action은 prepared 상태에서만 worker queue를 호출한다", async () => {
  const rejectedStates: Array<{
    state: Exclude<PlatformSandboxResetRemoteState, "prepared">;
    message: RegExp;
  }> = [
    { state: "absent", message: /영구 미시작 종료/ },
    { state: "completed", message: /플랫폼 적용 확인/ },
    { state: "closed_not_started", message: /플랫폼 미적용 확인/ },
  ];

  for (const { state, message } of rejectedStates) {
    let queued = false;
    await assert.rejects(
      () =>
        resumePreparedSandboxResetWhenPrepared(state, async () => {
          queued = true;
        }),
      message,
    );
    assert.equal(
      queued,
      false,
      `${state} 상태에서 resume queue를 호출하면 안 됩니다.`,
    );
  }

  let queued = false;
  await resumePreparedSandboxResetWhenPrepared("prepared", async () => {
    queued = true;
  });
  assert.equal(queued, true);
});
