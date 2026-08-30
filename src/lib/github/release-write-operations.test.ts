import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { Octokit } from "@/lib/github/app";
import {
  createOrUpdateReleaseWithExactLookup,
  createTagWithExactReadback,
  dispatchWorkflowWithExactTagBinding,
  readExactTagCommitSha,
  upsertReleaseAssetWithExactBinding,
} from "@/lib/github/release-write-operations";
import { FLEET_GITHUB_CAPABILITY_PERMISSIONS } from "@/lib/github/scoped-installation-client";

const OWNER = "seorilabs";
const REPO = "lizard-tycoon";
const TAG = "v1.2.2";
const SHA = "1".repeat(40);
const OTHER_SHA = "2".repeat(40);
const TAG_OBJECT_SHA = "3".repeat(40);

function missing(): Error & { status: number } {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

function client(input: {
  getRef?: (...args: unknown[]) => Promise<unknown>;
  getTag?: () => Promise<unknown>;
  createRef?: () => Promise<unknown>;
  getReleaseByTag?: () => Promise<unknown>;
  updateRelease?: () => Promise<unknown>;
  createRelease?: () => Promise<unknown>;
  createWorkflowDispatch?: () => Promise<unknown>;
  getRelease?: () => Promise<unknown>;
  uploadReleaseAsset?: () => Promise<unknown>;
  listReleaseAssets?: () => Promise<unknown>;
  deleteReleaseAsset?: () => Promise<unknown>;
}): Octokit {
  return {
    rest: {
      git: {
        getRef: input.getRef ?? (async () => { throw missing(); }),
        getTag: input.getTag ?? (async () => { throw missing(); }),
        createRef: input.createRef ?? (async () => ({ data: {} })),
      },
      repos: {
        getReleaseByTag: input.getReleaseByTag ?? (async () => { throw missing(); }),
        updateRelease: input.updateRelease ?? (async () => ({ data: {} })),
        createRelease: input.createRelease ?? (async () => ({ data: {} })),
        getRelease: input.getRelease ?? (async () => ({ data: {} })),
        uploadReleaseAsset: input.uploadReleaseAsset ?? (async () => ({ data: {} })),
        listReleaseAssets: input.listReleaseAssets ?? (async () => ({ data: [] })),
        deleteReleaseAsset: input.deleteReleaseAsset ?? (async () => ({ data: {} })),
      },
      actions: {
        createWorkflowDispatch: input.createWorkflowDispatch ?? (async () => ({ data: {} })),
      },
    },
  } as unknown as Octokit;
}

function ref(sha: string, type: "commit" | "tag" = "commit") {
  return { data: { ref: `refs/tags/${TAG}`, object: { sha, type } } };
}

test("annotated tag chain을 exact commit까지 peel한다", async () => {
  const result = await readExactTagCommitSha(client({
    getRef: async () => ref(TAG_OBJECT_SHA, "tag"),
    getTag: async () => ({ data: { sha: TAG_OBJECT_SHA, object: { sha: SHA, type: "commit" } } }),
  }), { owner: OWNER, repo: REPO, tag: TAG });
  assert.equal(result, SHA);
});

test("tag 생성 성공은 post-write exact ref readback 뒤에만 완료된다", async () => {
  let reads = 0;
  let creates = 0;
  const result = await createTagWithExactReadback(client({
    getRef: async () => {
      reads += 1;
      if (reads === 1) throw missing();
      return ref(SHA);
    },
    createRef: async () => {
      creates += 1;
      return { data: { ref: `refs/tags/${TAG}` } };
    },
  }), { owner: OWNER, repo: REPO, tag: TAG, sha: SHA });
  assert.deepEqual(result, { created: true });
  assert.equal(creates, 1);
  assert.equal(reads, 2);
});

test("일반 createRef 422는 duplicate 성공으로 오인하지 않는다", async () => {
  const unprocessable = Object.assign(new Error("Validation Failed"), { status: 422 });
  await assert.rejects(
    () => createTagWithExactReadback(client({
      getRef: async () => { throw missing(); },
      createRef: async () => { throw unprocessable; },
    }), { owner: OWNER, repo: REPO, tag: TAG, sha: SHA }),
    (error) => error === unprocessable,
  );
});

test("422 이후 exact same tag commit readback만 동시 duplicate로 인정한다", async () => {
  const unprocessable = Object.assign(new Error("Validation Failed"), { status: 422 });
  let reads = 0;
  const result = await createTagWithExactReadback(client({
    getRef: async () => {
      reads += 1;
      if (reads === 1) throw missing();
      return ref(SHA);
    },
    createRef: async () => { throw unprocessable; },
  }), { owner: OWNER, repo: REPO, tag: TAG, sha: SHA });
  assert.deepEqual(result, { created: false });
});

test("422 이후 다른 commit의 tag가 보이면 duplicate로 처리하지 않는다", async () => {
  const unprocessable = Object.assign(new Error("Validation Failed"), { status: 422 });
  let reads = 0;
  await assert.rejects(
    () => createTagWithExactReadback(client({
      getRef: async () => {
        reads += 1;
        if (reads === 1) throw missing();
        return ref(OTHER_SHA);
      },
      createRef: async () => { throw unprocessable; },
    }), { owner: OWNER, repo: REPO, tag: TAG, sha: SHA }),
    (error) => error === unprocessable,
  );
});

test("이미 존재하는 exact tag가 다른 commit이면 createRef 없이 거부한다", async () => {
  let creates = 0;
  await assert.rejects(
    () => createTagWithExactReadback(client({
      getRef: async () => ref(OTHER_SHA),
      createRef: async () => {
        creates += 1;
        return { data: {} };
      },
    }), { owner: OWNER, repo: REPO, tag: TAG, sha: SHA }),
    /다른 커밋/u,
  );
  assert.equal(creates, 0);
});

test("post-write tag commit drift는 성공 응답 뒤에도 fail-closed한다", async () => {
  let reads = 0;
  await assert.rejects(
    () => createTagWithExactReadback(client({
      getRef: async () => {
        reads += 1;
        if (reads === 1) throw missing();
        return ref(OTHER_SHA);
      },
      createRef: async () => ({ data: {} }),
    }), { owner: OWNER, repo: REPO, tag: TAG, sha: SHA }),
    /POST_WRITE_READBACK_MISMATCH/u,
  );
});

test("Release 조회의 비-404 오류는 create로 폴백하지 않고 그대로 전파한다", async () => {
  const forbidden = Object.assign(new Error("Forbidden"), { status: 403 });
  let creates = 0;
  await assert.rejects(
    () => createOrUpdateReleaseWithExactLookup(client({
      getRef: async () => ref(SHA),
      getReleaseByTag: async () => { throw forbidden; },
      createRelease: async () => {
        creates += 1;
        return { data: {} };
      },
    }), { owner: OWNER, repo: REPO, tag: TAG, expectedSha: SHA, body: "notes" }),
    (error) => error === forbidden,
  );
  assert.equal(creates, 0);
});

test("Release 404만 부재로 판정해 새 Release를 만든다", async () => {
  let targetCommitish = "";
  const result = await createOrUpdateReleaseWithExactLookup(client({
    getRef: async () => ref(SHA),
    getReleaseByTag: async () => { throw missing(); },
    createRelease: async (...args: unknown[]) => {
      targetCommitish = (args[0] as { target_commitish?: string }).target_commitish ?? "";
      return {
        data: { id: 17, html_url: "https://example.test/release", tag_name: TAG },
      };
    },
  }), { owner: OWNER, repo: REPO, tag: TAG, expectedSha: SHA, body: "notes" });
  assert.deepEqual(result, { id: 17, url: "https://example.test/release" });
  assert.equal(targetCommitish, SHA);
});

test("exact tag가 없으면 GitHub Release API가 암묵 태그를 만들기 전에 차단한다", async () => {
  let creates = 0;
  await assert.rejects(
    () => createOrUpdateReleaseWithExactLookup(client({
      getRef: async () => { throw missing(); },
      createRelease: async () => {
        creates += 1;
        return { data: {} };
      },
    }), { owner: OWNER, repo: REPO, tag: TAG, expectedSha: SHA, body: "notes" }),
    (error) => (error as { status?: number }).status === 404,
  );
  assert.equal(creates, 0);
});

test("Release 생성 후 tag가 다른 commit으로 바뀌면 성공 응답도 거부한다", async () => {
  let reads = 0;
  await assert.rejects(
    () => createOrUpdateReleaseWithExactLookup(client({
      getRef: async () => {
        reads += 1;
        return ref(reads === 1 ? SHA : OTHER_SHA);
      },
      getReleaseByTag: async () => { throw missing(); },
      createRelease: async () => ({
        data: { id: 17, html_url: "https://example.test/release", tag_name: TAG },
      }),
    }), { owner: OWNER, repo: REPO, tag: TAG, expectedSha: SHA, body: "notes" }),
    /GITHUB_RELEASE_TAG_SHA_MISMATCH/u,
  );
});

test("Release create 422 race는 desired 본문으로 update한 뒤에만 멱등 성공한다", async () => {
  const unprocessable = Object.assign(new Error("Validation Failed"), { status: 422 });
  let releaseReads = 0;
  let updates = 0;
  const result = await createOrUpdateReleaseWithExactLookup(client({
    getRef: async () => ref(SHA),
    getReleaseByTag: async () => {
      releaseReads += 1;
      if (releaseReads === 1) throw missing();
      return {
        data: { id: 17, html_url: "https://example.test/raced", tag_name: TAG },
      };
    },
    createRelease: async () => { throw unprocessable; },
    updateRelease: async () => {
      updates += 1;
      return {
        data: { id: 17, html_url: "https://example.test/converged", tag_name: TAG },
      };
    },
  }), { owner: OWNER, repo: REPO, tag: TAG, expectedSha: SHA, body: "desired notes" });

  assert.deepEqual(result, { id: 17, url: "https://example.test/converged" });
  assert.equal(updates, 1);
});

test("workflow dispatch는 scoped client에서 exact tag SHA를 읽은 뒤 한 번만 실행한다", async () => {
  let dispatches = 0;
  await dispatchWorkflowWithExactTagBinding(client({
    getRef: async (...args: unknown[]) => {
      const request = args[0] as { ref?: string };
      if (request.ref === `heads/${TAG}`) throw missing();
      return ref(SHA);
    },
    createWorkflowDispatch: async () => {
      dispatches += 1;
      return { data: {} };
    },
  }), {
    owner: OWNER,
    repo: REPO,
    workflowFile: "deploy-google-play.yml",
    ref: TAG,
    inputs: { release_tag: TAG },
    expectedTag: TAG,
    expectedSha: SHA,
  });
  assert.equal(dispatches, 1);
});

test("workflow dispatch는 tag SHA 또는 stable ref binding이 다르면 write 전에 차단한다", async () => {
  let dispatches = 0;
  const octokit = client({
    getRef: async (...args: unknown[]) => {
      const request = args[0] as { ref?: string };
      if (request.ref === `heads/${TAG}`) throw missing();
      return ref(OTHER_SHA);
    },
    createWorkflowDispatch: async () => {
      dispatches += 1;
      return { data: {} };
    },
  });
  await assert.rejects(
    () => dispatchWorkflowWithExactTagBinding(octokit, {
      owner: OWNER,
      repo: REPO,
      workflowFile: "deploy-google-play.yml",
      ref: TAG,
      inputs: { release_tag: TAG },
      expectedTag: TAG,
      expectedSha: SHA,
    }),
    /GITHUB_WORKFLOW_RELEASE_TAG_SHA_MISMATCH/u,
  );
  await assert.rejects(
    () => dispatchWorkflowWithExactTagBinding(octokit, {
      owner: OWNER,
      repo: REPO,
      workflowFile: "deploy-google-play.yml",
      ref: "v9.9.9",
      inputs: { release_tag: TAG },
      expectedTag: TAG,
      expectedSha: SHA,
    }),
    /GITHUB_WORKFLOW_RELEASE_TAG_BINDING_MISMATCH/u,
  );
  assert.equal(dispatches, 0);
});

test("stable tag와 같은 이름의 branch가 있으면 workflow ref ambiguity를 차단한다", async () => {
  let dispatches = 0;
  await assert.rejects(
    () => dispatchWorkflowWithExactTagBinding(client({
      getRef: async () => ({
        data: { ref: `refs/heads/${TAG}`, object: { sha: SHA, type: "commit" } },
      }),
      createWorkflowDispatch: async () => {
        dispatches += 1;
        return { data: {} };
      },
    }), {
      owner: OWNER,
      repo: REPO,
      workflowFile: "deploy-google-play.yml",
      ref: TAG,
      inputs: { release_tag: TAG },
      expectedTag: TAG,
      expectedSha: SHA,
    }),
    /GITHUB_WORKFLOW_RELEASE_TAG_BRANCH_AMBIGUOUS/u,
  );
  assert.equal(dispatches, 0);
});

test("snapshot caller가 release_tag 없이 tag ref 자체로 결합해도 exact dispatch를 허용한다", async () => {
  const snapshotTag = "v1.2.2-snapshot.1";
  let dispatches = 0;
  await dispatchWorkflowWithExactTagBinding(client({
    getRef: async (...args: unknown[]) => {
      const request = args[0] as { ref?: string };
      if (request.ref === `heads/${snapshotTag}`) throw missing();
      return {
        data: { ref: `refs/tags/${snapshotTag}`, object: { sha: SHA, type: "commit" } },
      };
    },
    createWorkflowDispatch: async () => {
      dispatches += 1;
      return { data: {} };
    },
  }), {
    owner: OWNER,
    repo: REPO,
    workflowFile: "deploy-google-play.yml",
    ref: snapshotTag,
    inputs: { snapshot_candidate: "true" },
    expectedTag: snapshotTag,
    expectedSha: SHA,
  });
  assert.equal(dispatches, 1);
});

test("Release asset은 release ID의 tag와 peeled SHA가 모두 맞을 때만 upload한다", async () => {
  let uploads = 0;
  const result = await upsertReleaseAssetWithExactBinding(client({
    getRef: async () => ref(SHA),
    getRelease: async () => ({ data: { id: 17, tag_name: TAG } }),
    uploadReleaseAsset: async () => {
      uploads += 1;
      return { data: { browser_download_url: "https://example.test/asset" } };
    },
  }), {
    owner: OWNER,
    repo: REPO,
    releaseId: 17,
    tag: TAG,
    expectedSha: SHA,
    name: "release-notes.json",
    contentType: "application/json",
    data: "{}",
  });
  assert.deepEqual(result, { url: "https://example.test/asset" });
  assert.equal(uploads, 1);
});

test("Release asset의 release tag 또는 peeled SHA가 다르면 upload와 delete가 0회다", async () => {
  for (const mismatch of ["release", "sha"] as const) {
    let uploads = 0;
    let deletes = 0;
    await assert.rejects(
      () => upsertReleaseAssetWithExactBinding(client({
        getRef: async () => ref(mismatch === "sha" ? OTHER_SHA : SHA),
        getRelease: async () => ({
          data: { id: 17, tag_name: mismatch === "release" ? "v9.9.9" : TAG },
        }),
        uploadReleaseAsset: async () => {
          uploads += 1;
          return { data: {} };
        },
        deleteReleaseAsset: async () => {
          deletes += 1;
          return { data: {} };
        },
      }), {
        owner: OWNER,
        repo: REPO,
        releaseId: 17,
        tag: TAG,
        expectedSha: SHA,
        name: "release-notes.json",
        contentType: "application/json",
        data: "{}",
      }),
      /GITHUB_RELEASE_ASSET_(?:RELEASE_IDENTITY|TAG_SHA)_MISMATCH/u,
    );
    assert.equal(uploads, 0);
    assert.equal(deletes, 0);
  }
});

test("Release asset 422에 같은 이름 충돌이 없으면 delete/retry하지 않는다", async () => {
  const unprocessable = Object.assign(new Error("Validation Failed"), { status: 422 });
  let uploads = 0;
  let deletes = 0;
  await assert.rejects(
    () => upsertReleaseAssetWithExactBinding(client({
      getRef: async () => ref(SHA),
      getRelease: async () => ({ data: { id: 17, tag_name: TAG } }),
      uploadReleaseAsset: async () => {
        uploads += 1;
        throw unprocessable;
      },
      listReleaseAssets: async () => ({ data: [] }),
      deleteReleaseAsset: async () => {
        deletes += 1;
        return { data: {} };
      },
    }), {
      owner: OWNER,
      repo: REPO,
      releaseId: 17,
      tag: TAG,
      expectedSha: SHA,
      name: "release-notes.json",
      contentType: "application/json",
      data: "{}",
    }),
    (error) => error === unprocessable,
  );
  assert.equal(uploads, 1);
  assert.equal(deletes, 0);
});

test("release와 dispatch mutation은 numeric repo scoped capability만 사용한다", () => {
  assert.deepEqual(FLEET_GITHUB_CAPABILITY_PERMISSIONS["github.release.write"], {
    contents: "write",
    metadata: "read",
  });
  assert.deepEqual(FLEET_GITHUB_CAPABILITY_PERMISSIONS["github.workflow-dispatch.write"], {
    actions: "write",
    contents: "read",
    metadata: "read",
  });
  const source = readFileSync(join(process.cwd(), "src/lib/github/write.ts"), "utf8");
  assert.match(source, /repositoryId: String\(repository\.data\.id\)/u);
  assert.match(source, /withFleetScopedGithubClient\(\{/u);
  assert.match(source, /capability: "github\.release\.write"/u);
  assert.match(source, /capability: "github\.workflow-dispatch\.write"/u);
});
