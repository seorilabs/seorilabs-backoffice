import type { Octokit } from "@/lib/github/app";

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_TAG_DEPTH = 8;

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

function assertTagName(tag: string): void {
  if (!TAG_NAME.test(tag)) throw new Error("GITHUB_TAG_NAME_INVALID");
}

function assertCommitSha(sha: string): string {
  const normalized = sha.toLowerCase();
  if (!COMMIT_SHA.test(normalized)) throw new Error("GITHUB_TAG_COMMIT_SHA_INVALID");
  return normalized;
}

/** exact refs/tags/<tag>를 읽고 annotated tag chain을 실제 commit까지 peel한다. */
export async function readExactTagCommitSha(
  client: Octokit,
  input: { owner: string; repo: string; tag: string },
): Promise<string> {
  assertTagName(input.tag);
  const expectedRef = `refs/tags/${input.tag}`;
  const response = await client.rest.git.getRef({
    owner: input.owner,
    repo: input.repo,
    ref: `tags/${input.tag}`,
  });
  if (response.data.ref !== expectedRef) throw new Error("GITHUB_TAG_REF_IDENTITY_MISMATCH");

  let object = response.data.object;
  const visited = new Set<string>();
  for (let depth = 0; depth < MAX_TAG_DEPTH; depth += 1) {
    const sha = assertCommitSha(object.sha);
    if (object.type === "commit") return sha;
    if (object.type !== "tag" || visited.has(sha)) {
      throw new Error("GITHUB_TAG_PEELED_COMMIT_INVALID");
    }
    visited.add(sha);
    const tagObject = await client.rest.git.getTag({
      owner: input.owner,
      repo: input.repo,
      tag_sha: sha,
    });
    if (assertCommitSha(tagObject.data.sha) !== sha) {
      throw new Error("GITHUB_TAG_OBJECT_IDENTITY_MISMATCH");
    }
    object = tagObject.data.object;
  }
  throw new Error("GITHUB_TAG_PEELED_COMMIT_INVALID");
}

async function readTagOrNull(
  client: Octokit,
  input: { owner: string; repo: string; tag: string },
): Promise<string | null> {
  try {
    return await readExactTagCommitSha(client, input);
  } catch (error) {
    if (statusOf(error) === 404) return null;
    throw error;
  }
}

/**
 * lightweight tag를 create-only로 만들고 exact ref를 다시 peel해 요청 commit과 일치시킨다.
 * 일반 422는 duplicate가 아니다. 동시 생성된 exact same ref readback만 idempotent로 인정한다.
 */
export async function createTagWithExactReadback(
  client: Octokit,
  input: { owner: string; repo: string; tag: string; sha: string },
): Promise<{ created: boolean }> {
  assertTagName(input.tag);
  const expectedSha = assertCommitSha(input.sha);
  const existing = await readTagOrNull(client, input);
  if (existing !== null) {
    if (existing !== expectedSha) {
      throw new Error(`태그 ${input.tag}가 다른 커밋(${existing.slice(0, 7)})에 이미 존재합니다.`);
    }
    return { created: false };
  }

  try {
    await client.rest.git.createRef({
      owner: input.owner,
      repo: input.repo,
      ref: `refs/tags/${input.tag}`,
      sha: expectedSha,
    });
  } catch (error) {
    if (statusOf(error) !== 422) throw error;
    let raced: string | null;
    try {
      raced = await readTagOrNull(client, input);
    } catch {
      throw error;
    }
    if (raced === expectedSha) return { created: false };
    throw error;
  }

  const readback = await readExactTagCommitSha(client, input);
  if (readback !== expectedSha) throw new Error("GITHUB_TAG_POST_WRITE_READBACK_MISMATCH");
  return { created: true };
}

/** Release 조회는 404만 부재로 취급하며 그 밖의 provider 오류는 그대로 보존한다. */
export async function createOrUpdateReleaseWithExactLookup(
  client: Octokit,
  input: {
    owner: string;
    repo: string;
    tag: string;
    expectedSha: string;
    name?: string;
    body: string;
    prerelease?: boolean;
  },
): Promise<{ url: string; id: number }> {
  assertTagName(input.tag);
  const expectedSha = assertCommitSha(input.expectedSha);
  const assertTagBinding = async (): Promise<void> => {
    const observed = await readExactTagCommitSha(client, input);
    if (observed !== expectedSha) throw new Error("GITHUB_RELEASE_TAG_SHA_MISMATCH");
  };
  const assertReleaseIdentity = (release: { tag_name?: string }): void => {
    if (release.tag_name !== input.tag) throw new Error("GITHUB_RELEASE_TAG_IDENTITY_MISMATCH");
  };

  // Release API는 tag가 없으면 default branch에 암묵 태그를 만들 수 있다. 먼저 exact ref를
  // peel하고 모든 write에 expected commit을 결합해 그 fallback을 차단한다.
  await assertTagBinding();
  let existing: Awaited<ReturnType<Octokit["rest"]["repos"]["getReleaseByTag"]>> | null;
  try {
    existing = await client.rest.repos.getReleaseByTag({
      owner: input.owner,
      repo: input.repo,
      tag: input.tag,
    });
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    existing = null;
  }

  if (existing) {
    assertReleaseIdentity(existing.data);
    const response = await client.rest.repos.updateRelease({
      owner: input.owner,
      repo: input.repo,
      release_id: existing.data.id,
      name: input.name ?? input.tag,
      body: input.body,
      ...(input.prerelease != null ? { prerelease: input.prerelease } : {}),
    });
    assertReleaseIdentity(response.data);
    await assertTagBinding();
    return { url: response.data.html_url, id: response.data.id };
  }

  let response: Awaited<ReturnType<Octokit["rest"]["repos"]["createRelease"]>>;
  try {
    response = await client.rest.repos.createRelease({
      owner: input.owner,
      repo: input.repo,
      tag_name: input.tag,
      target_commitish: expectedSha,
      name: input.name ?? input.tag,
      body: input.body,
      prerelease: input.prerelease ?? false,
    });
  } catch (error) {
    if (statusOf(error) !== 422) throw error;
    let raced: Awaited<ReturnType<Octokit["rest"]["repos"]["getReleaseByTag"]>>;
    try {
      raced = await client.rest.repos.getReleaseByTag({
        owner: input.owner,
        repo: input.repo,
        tag: input.tag,
      });
    } catch (readError) {
      if (statusOf(readError) === 404) throw error;
      throw readError;
    }
    assertReleaseIdentity(raced.data);
    await assertTagBinding();
    // create 결과 불명/동시 생성은 desired body로 다시 수렴시킨 뒤에만 멱등 성공이다.
    const converged = await client.rest.repos.updateRelease({
      owner: input.owner,
      repo: input.repo,
      release_id: raced.data.id,
      name: input.name ?? input.tag,
      body: input.body,
      ...(input.prerelease != null ? { prerelease: input.prerelease } : {}),
    });
    assertReleaseIdentity(converged.data);
    await assertTagBinding();
    return { url: converged.data.html_url, id: converged.data.id };
  }
  assertReleaseIdentity(response.data);
  await assertTagBinding();
  return { url: response.data.html_url, id: response.data.id };
}

/** release_tag dispatch는 scoped client 안에서 exact tag를 다시 peel한 직후 실행한다. */
export async function dispatchWorkflowWithExactTagBinding(
  client: Octokit,
  input: {
    owner: string;
    repo: string;
    workflowFile: string;
    ref: string;
    inputs: Record<string, string>;
    expectedTag: string;
    expectedSha: string;
  },
): Promise<void> {
  assertTagName(input.expectedTag);
  const expectedSha = assertCommitSha(input.expectedSha);
  const releaseTag = input.inputs.release_tag;
  if (
    (releaseTag !== undefined && releaseTag !== input.expectedTag)
    || input.ref !== input.expectedTag
  ) {
    throw new Error("GITHUB_WORKFLOW_RELEASE_TAG_BINDING_MISMATCH");
  }
  if (input.ref === input.expectedTag) {
    try {
      await client.rest.git.getRef({
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.ref}`,
      });
      throw new Error("GITHUB_WORKFLOW_RELEASE_TAG_BRANCH_AMBIGUOUS");
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  }
  const observed = await readExactTagCommitSha(client, {
    owner: input.owner,
    repo: input.repo,
    tag: input.expectedTag,
  });
  if (observed !== expectedSha) {
    throw new Error("GITHUB_WORKFLOW_RELEASE_TAG_SHA_MISMATCH");
  }
  await client.rest.actions.createWorkflowDispatch({
    owner: input.owner,
    repo: input.repo,
    workflow_id: input.workflowFile,
    ref: input.ref,
    inputs: input.inputs,
  });
}

/** Release asset write는 release ID의 tag와 exact peeled commit을 매 mutation 직전에 확인한다. */
export async function upsertReleaseAssetWithExactBinding(
  client: Octokit,
  input: {
    owner: string;
    repo: string;
    releaseId: number;
    tag: string;
    expectedSha: string;
    name: string;
    contentType: string;
    data: string;
  },
): Promise<{ url: string }> {
  assertTagName(input.tag);
  const expectedSha = assertCommitSha(input.expectedSha);
  const assertBinding = async (): Promise<void> => {
    const release = await client.rest.repos.getRelease({
      owner: input.owner,
      repo: input.repo,
      release_id: input.releaseId,
    });
    if (release.data.id !== input.releaseId || release.data.tag_name !== input.tag) {
      throw new Error("GITHUB_RELEASE_ASSET_RELEASE_IDENTITY_MISMATCH");
    }
    const observed = await readExactTagCommitSha(client, input);
    if (observed !== expectedSha) {
      throw new Error("GITHUB_RELEASE_ASSET_TAG_SHA_MISMATCH");
    }
  };
  const upload = () => client.rest.repos.uploadReleaseAsset({
    owner: input.owner,
    repo: input.repo,
    release_id: input.releaseId,
    name: input.name,
    data: input.data,
    headers: { "content-type": input.contentType },
  });

  await assertBinding();
  try {
    const response = await upload();
    await assertBinding();
    return { url: response.data.browser_download_url };
  } catch (error) {
    if (statusOf(error) !== 422) throw error;
    const existing = await client.rest.repos.listReleaseAssets({
      owner: input.owner,
      repo: input.repo,
      release_id: input.releaseId,
      per_page: 100,
    });
    const conflicts = existing.data.filter((item) => item.name === input.name);
    if (conflicts.length === 0) throw error;
    await assertBinding();
    for (const asset of conflicts) {
      await assertBinding();
      await client.rest.repos.deleteReleaseAsset({
        owner: input.owner,
        repo: input.repo,
        asset_id: asset.id,
      });
    }
    await assertBinding();
    const response = await upload();
    await assertBinding();
    return { url: response.data.browser_download_url };
  }
}
