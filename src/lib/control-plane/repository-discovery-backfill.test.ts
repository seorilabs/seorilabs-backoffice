import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assertFullOrganizationInstallation,
  listInstallationRepositorySeeds,
  readRepositoryBackfillVector,
  reconcileOrganizationRepositoryDiscovery,
  repositoryBackfillDeliveryId,
  repositoryBackfillRegistrationInput,
  type RepositoryInventoryClient,
  type RepositoryReadbackVector,
} from "@/lib/control-plane/repository-discovery-backfill";
import { computeRepositoryDiscoveryBackfill } from "@/lib/control-plane/repository-discovery-backfill-http";

const SHA = "a".repeat(40);

function response(data: unknown): Promise<{ data: unknown }> {
  return Promise.resolve({ data });
}

test("installation repository pagination은 numeric ID를 중복 없이 정렬한다", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client: RepositoryInventoryClient = {
    request(route, parameters) {
      calls.push({ route, ...parameters });
      if (parameters.page === 1) return response({ repositories: [{ id: 3 }, { id: 1 }] });
      return response({ repositories: [{ id: 3 }] });
    },
  };
  assert.deepEqual(await listInstallationRepositorySeeds(client, 2), [
    { repoId: 1 },
    { repoId: 3 },
  ]);
  assert.deepEqual(calls.map(({ route, page }) => [route, page]), [
    ["GET /installation/repositories", 1],
    ["GET /installation/repositories", 2],
  ]);
});

test("selected-repository 또는 다른 조직 설치는 full-org backfill을 fail-closed한다", () => {
  assert.doesNotThrow(() => assertFullOrganizationInstallation({
    repositorySelection: "all",
    targetType: "Organization",
    accountLogin: "SeoriLabs",
  }, "seorilabs"));
  for (const installation of [{
    repositorySelection: "selected",
    targetType: "Organization",
    accountLogin: "seorilabs",
  }, {
    repositorySelection: "all",
    targetType: "Organization",
    accountLogin: "different-org",
  }]) {
    assert.throws(
      () => assertFullOrganizationInstallation(installation, "seorilabs"),
      /REPOSITORY_BACKFILL_INSTALLATION_NOT_FULL_ORG/,
    );
  }
});

test("backfill은 shadow 외 실행 모드를 provider read 전에 거부한다", async () => {
  let clientRequested = false;
  await assert.rejects(reconcileOrganizationRepositoryDiscovery({
    organization: "seorilabs",
    mode: "enforce",
  }, {
    getClient: async () => {
      clientRequested = true;
      throw new Error("unexpected");
    },
    enqueue: async () => ({ duplicate: false, enqueued: false }),
    audit: async () => undefined,
    now: () => new Date("2026-08-28T04:00:00.000Z"),
    randomId: () => "run",
  }), /REPOSITORY_BACKFILL_MODE_NOT_SHADOW/);
  assert.equal(clientRequested, false);
});

test("active private 저장소는 numeric ID와 canonical identity를 재확인하고 exact default HEAD를 묶는다", async () => {
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const repository = {
    id: 42,
    full_name: "seorilabs/renamed-app",
    name: "renamed-app",
    default_branch: "main",
    archived: false,
    private: true,
  };
  const client: RepositoryInventoryClient = {
    request(route, parameters) {
      calls.push({ route, parameters });
      if (route === "GET /repositories/{repository_id}") return response(repository);
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") return response({ sha: SHA.toUpperCase() });
      throw new Error(`unexpected route ${route}`);
    },
  };
  assert.deepEqual(await readRepositoryBackfillVector(client, "seorilabs", { repoId: 42 }), {
    repoId: 42,
    repoFullName: "seorilabs/renamed-app",
    name: "renamed-app",
    defaultBranch: "main",
    archived: false,
    private: true,
    headSha: SHA,
  });
  assert.equal(calls.filter(({ route }) => route === "GET /repositories/{repository_id}").length, 2);
  assert.deepEqual(calls.find(({ route }) => route.includes("commits"))?.parameters, {
    owner: "seorilabs",
    repo: "renamed-app",
    ref: "main",
  });
});

test("archive와 public repository는 source를 읽지 않고 lifecycle/policy reconcile vector만 만든다", async () => {
  for (const repository of [{
    id: 11,
    full_name: "seorilabs/archived-app",
    name: "archived-app",
    default_branch: "main",
    archived: true,
    private: true,
  }, {
    id: 12,
    full_name: "seorilabs/public-app",
    name: "public-app",
    default_branch: "main",
    archived: false,
    private: false,
  }]) {
    const routes: string[] = [];
    const vector = await readRepositoryBackfillVector({
      request(route) {
        routes.push(route);
        return response(repository);
      },
    }, "seorilabs", { repoId: repository.id });
    assert.equal(vector.headSha, null);
    assert.deepEqual(routes, ["GET /repositories/{repository_id}"]);
  }
});

test("identity가 HEAD read 사이에 바뀌면 stale vector를 enqueue하지 않는다", async () => {
  let identityReads = 0;
  const client: RepositoryInventoryClient = {
    request(route) {
      if (route.includes("commits")) return response({ sha: SHA });
      identityReads += 1;
      const name = identityReads === 1 ? "before-rename" : "after-rename";
      return response({
        id: 9,
        full_name: `seorilabs/${name}`,
        name,
        default_branch: "main",
        archived: false,
        private: true,
      });
    },
  };
  await assert.rejects(
    readRepositoryBackfillVector(client, "seorilabs", { repoId: 9 }),
    /REPOSITORY_BACKFILL_VECTOR_DRIFT/,
  );
});

test("같은 sweep occurrence와 provider vector는 같은 delivery이고 ABA 재등장은 새 occurrence로 구분한다", () => {
  const vector: RepositoryReadbackVector = {
    repoId: 42,
    repoFullName: "seorilabs/sample-app",
    name: "sample-app",
    defaultBranch: "main",
    archived: false,
    private: true,
    headSha: SHA,
  };
  const first = repositoryBackfillDeliveryId("seorilabs", vector, "sweep-1");
  assert.equal(first, repositoryBackfillDeliveryId("seorilabs", { ...vector }, "sweep-1"));
  assert.notEqual(first, repositoryBackfillDeliveryId("seorilabs", vector, "sweep-2"));
  assert.notEqual(first, repositoryBackfillDeliveryId("seorilabs", {
    ...vector,
    headSha: "b".repeat(40),
  }, "sweep-1"));
  assert.notEqual(first, repositoryBackfillDeliveryId("seorilabs", {
    ...vector,
    repoFullName: "seorilabs/renamed-app",
    name: "renamed-app",
  }, "sweep-1"));
  assert.deepEqual(repositoryBackfillRegistrationInput("seorilabs", vector, "sweep-1"), {
    event: "reconcile",
    action: "full-org-readback",
    repository: {
      id: 42,
      full_name: "seorilabs/sample-app",
      name: "sample-app",
      default_branch: "main",
      archived: false,
      private: true,
    },
    after: SHA,
    deliveryId: first,
    organization: "seorilabs",
  });
});

test("full-org sweep는 active private, archive, public을 각각 수렴하고 repo 실패만 partial로 격리한다", async () => {
  const repositories = new Map<number, Record<string, unknown>>([
    [1, { id: 1, full_name: "seorilabs/app", name: "app", default_branch: "main", archived: false, private: true }],
    [2, { id: 2, full_name: "seorilabs/old", name: "old", default_branch: "main", archived: true, private: true }],
    [3, { id: 3, full_name: "seorilabs/public", name: "public", default_branch: "main", archived: false, private: false }],
  ]);
  const enqueued: Array<{ input: { repository: { id: number; archived?: boolean } }; at: Date }> = [];
  const audits: Array<{ action: string; payload: unknown }> = [];
  const client: RepositoryInventoryClient = {
    request(route, parameters) {
      if (route === "GET /installation/repositories") {
        return response({ repositories: [{ id: 3 }, { id: 2 }, { id: 1 }, { id: 4 }] });
      }
      if (route === "GET /repositories/{repository_id}") {
        const repo = repositories.get(parameters.repository_id as number);
        if (!repo) return response({ id: "invalid" });
        return response(repo);
      }
      if (route.includes("commits")) return response({ sha: SHA });
      throw new Error(`unexpected route ${route}`);
    },
  };
  const now = new Date("2026-08-28T04:00:00.000Z");
  const result = await reconcileOrganizationRepositoryDiscovery({ organization: "seorilabs" }, {
    getClient: async () => client,
    enqueue: async (input, at) => {
      enqueued.push({ input, at });
      return { duplicate: false, enqueued: input.repository.archived !== true };
    },
    audit: async (input) => { audits.push(input); },
    now: () => now,
    randomId: () => "backfill-run-1",
  });
  assert.deepEqual(result, {
    runId: "backfill-run-1",
    mode: "shadow",
    repositories: 4,
    observed: 3,
    eligible: 1,
    archived: 1,
    publicPolicy: 1,
    enqueued: 2,
    duplicate: 0,
    failed: 1,
    state: "partial",
    ok: false,
  });
  assert.deepEqual(enqueued.map(({ input }) => input.repository.id), [1, 2, 3]);
  assert.equal(enqueued.every(({ at }) => at === now), true);
  assert.deepEqual(audits.map(({ action }) => action), [
    "control-plane.repository-discovery-backfill.started",
    "control-plane.repository-discovery-backfill.repository_failed",
    "control-plane.repository-discovery-backfill.completed",
  ]);
  assert.doesNotMatch(JSON.stringify(audits), /request header|authorization|token/i);
});

test("backfill HTTP 경계는 인증, partial retry와 오류 비노출을 유지한다", async () => {
  const completed = {
    runId: "run",
    mode: "shadow" as const,
    repositories: 1,
    observed: 1,
    eligible: 1,
    archived: 0,
    publicPolicy: 0,
    enqueued: 1,
    duplicate: 0,
    failed: 0,
    state: "completed" as const,
    ok: true,
  };
  let called = false;
  assert.equal((await computeRepositoryDiscoveryBackfill(null, "token", async () => {
    called = true;
    return completed;
  })).status, 401);
  assert.equal(called, false);
  assert.equal((await computeRepositoryDiscoveryBackfill("token", "token", async () => completed)).status, 200);
  assert.equal((await computeRepositoryDiscoveryBackfill("token", "token", async () => ({
    ...completed,
    failed: 1,
    state: "partial",
    ok: false,
  }))).status, 500);
  const failed = await computeRepositoryDiscoveryBackfill("token", "token", async () => {
    throw new Error("authorization: secret");
  });
  assert.deepEqual(failed, {
    status: 500,
    body: { error: "repository discovery backfill failed" },
  });
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
});

test("inventory 구현은 GitHub GET readback만 사용하고 mutation adapter를 import하지 않는다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/control-plane/repository-discovery-backfill.ts"), "utf8");
  assert.match(source, /GET \/installation\/repositories/);
  assert.match(source, /GET \/repositories\/\{repository_id\}/);
  assert.match(source, /GET \/repos\/\{owner\}\/\{repo\}\/commits\/\{ref\}/);
  assert.doesNotMatch(source, /github\/write|pulls\.create|repos\.update|actions\.createWorkflowDispatch/);
});
