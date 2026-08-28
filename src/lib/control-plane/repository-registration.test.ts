import assert from "node:assert/strict";
import test from "node:test";

import { repositoryDiscoveryTrigger } from "@/lib/control-plane/repository-registration";

const SHA = "a".repeat(40);

test("default branch push만 exact SHA discovery를 enqueue한다", () => {
  assert.deepEqual(repositoryDiscoveryTrigger({
    event: "push",
    defaultBranch: "main",
    ref: "refs/heads/main",
    after: SHA.toUpperCase(),
  }), {
    relevant: true,
    sourceSha: SHA,
    sourceRef: "refs/heads/main",
  });
  assert.deepEqual(repositoryDiscoveryTrigger({
    event: "push",
    defaultBranch: "main",
    ref: "refs/heads/feature/demo",
    after: SHA,
  }), {
    relevant: false,
    sourceSha: null,
    sourceRef: "refs/heads/main",
  });
});

test("created/renamed 이벤트는 worker readback에서 HEAD를 결합하도록 enqueue한다", () => {
  for (const action of ["created", "renamed"] as const) {
    assert.deepEqual(repositoryDiscoveryTrigger({
      event: "repository",
      action,
      defaultBranch: "main",
    }), {
      relevant: true,
      sourceSha: null,
      sourceRef: "refs/heads/main",
    });
  }
});

test("source drift reconcile은 검증된 current HEAD만 다음 generation에 넘긴다", () => {
  assert.deepEqual(repositoryDiscoveryTrigger({
    event: "reconcile",
    action: "source-drift",
    defaultBranch: "main",
    after: SHA,
  }), {
    relevant: true,
    sourceSha: SHA,
    sourceRef: "refs/heads/main",
  });
});
