import assert from "node:assert/strict";
import test from "node:test";

import {
  repositoryDiscoveryRequestHashMatches,
  repositoryDiscoveryRequestHashes,
  repositoryDiscoveryTrigger,
  repositoryGenerationAfterArchive,
} from "@/lib/control-plane/repository-registration";

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

test("archive 전이는 generation을 한 번 무효화하고 반복 archive는 다시 올리지 않는다", () => {
  assert.equal(repositoryGenerationAfterArchive({
    archived: false,
    reconcileGeneration: 4,
  }), 5);
  assert.equal(repositoryGenerationAfterArchive({
    archived: true,
    reconcileGeneration: 5,
  }), 5);
});

test("empty repository의 private/public 전환은 서로 다른 semantic reconcile이다", () => {
  const base = {
    event: "reconcile",
    action: "full-org-readback",
    repository: {
      id: 42,
      full_name: "seorilabs/empty-app",
      name: "empty-app",
      default_branch: null,
      archived: false,
    },
    deliveryId: "delivery",
    organization: "seorilabs",
  };
  const trigger = repositoryDiscoveryTrigger({
    event: base.event,
    action: base.action,
    defaultBranch: null,
  });
  const privateHashes = repositoryDiscoveryRequestHashes({
    ...base,
    repository: { ...base.repository, private: true },
  }, false, trigger);
  const publicHashes = repositoryDiscoveryRequestHashes({
    ...base,
    repository: { ...base.repository, private: false },
  }, false, trigger);
  assert.notEqual(privateHashes.current, publicHashes.current);
  assert.equal(privateHashes.legacyV1, publicHashes.legacyV1);
  assert.notEqual(privateHashes.legacyV2, privateHashes.legacyV1);
  assert.notEqual(privateHashes.legacyV2, publicHashes.legacyV2);
  assert.notEqual(privateHashes.current, privateHashes.legacyV1);
  assert.equal(repositoryDiscoveryRequestHashMatches(privateHashes.current, privateHashes), true);
  assert.equal(repositoryDiscoveryRequestHashMatches(privateHashes.legacyV2, privateHashes), true);
  assert.equal(repositoryDiscoveryRequestHashMatches(privateHashes.legacyV1, privateHashes), true);
  assert.equal(repositoryDiscoveryRequestHashMatches("0".repeat(64), privateHashes), false);
});

test("fork와 classification revision은 current hash에만 exact 결합한다", () => {
  const base = {
    event: "reconcile",
    action: "classification-decision",
    repository: {
      id: 42,
      full_name: "seorilabs/forked-app",
      default_branch: "main",
      archived: false,
      private: true,
      fork: false,
    },
    after: SHA,
    deliveryId: "classification-delivery",
    organization: "seorilabs",
    classificationDecisionRevision: 1,
  };
  const trigger = repositoryDiscoveryTrigger({
    event: base.event,
    action: base.action,
    defaultBranch: base.repository.default_branch,
    after: base.after,
  });
  const first = repositoryDiscoveryRequestHashes(base, false, trigger);
  const changedFork = repositoryDiscoveryRequestHashes({
    ...base,
    repository: { ...base.repository, fork: true },
  }, false, trigger);
  const changedRevision = repositoryDiscoveryRequestHashes({
    ...base,
    classificationDecisionRevision: 2,
  }, false, trigger);
  assert.notEqual(first.current, changedFork.current);
  assert.notEqual(first.current, changedRevision.current);
  assert.equal(first.legacyV2, changedFork.legacyV2);
  assert.equal(first.legacyV2, changedRevision.legacyV2);
});
