import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  readExactSourceFile,
  SOURCE_OBSERVATION_ABSOLUTE_MAX_BYTES,
  SOURCE_OBSERVATION_MAX_BYTES,
  toSourceMetadata,
  type SourceObservationInput,
  type SourceObservationOctokit,
} from "@/lib/github/source-observation";

const REPO_ID = 42;
const FULL_NAME = "seorilabs/sample-app";
const SOURCE_SHA = "a".repeat(40);
const BLOB_SHA = "b".repeat(40);
const PATH = "play-store/google-play.config.json";

type FakeValue = unknown | Error;

interface FakeCalls {
  repository: Array<Record<string, unknown>>;
  source: Array<Record<string, unknown>>;
  path: Array<Record<string, unknown>>;
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error("redacted upstream failure"), { status });
}

function resolveFake(value: FakeValue): { data: unknown } {
  if (value instanceof Error) throw value;
  return { data: value };
}

function fakeOctokit(overrides: {
  repository?: FakeValue;
  source?: FakeValue;
  content?: FakeValue;
} = {}): { octokit: SourceObservationOctokit; calls: FakeCalls } {
  const text = "{\"packageName\":\"com.seorilabs.sample\"}\n";
  const calls: FakeCalls = { repository: [], source: [], path: [] };
  const repository = overrides.repository ?? { id: REPO_ID, full_name: FULL_NAME };
  const source = overrides.source ?? { sha: SOURCE_SHA };
  const content = overrides.content ?? {
    type: "file",
    encoding: "base64",
    content: Buffer.from(text).toString("base64"),
    sha: BLOB_SHA,
    size: Buffer.byteLength(text),
  };

  const octokit = {
    rest: {
      repos: {
        async get(args: Record<string, unknown>) {
          calls.repository.push(args);
          return resolveFake(repository);
        },
        async getCommit(args: Record<string, unknown>) {
          calls.source.push(args);
          return resolveFake(source);
        },
        async getContent(args: Record<string, unknown>) {
          calls.path.push(args);
          return resolveFake(content);
        },
      },
    },
  } as unknown as SourceObservationOctokit;
  return { octokit, calls };
}

function input(overrides: Partial<SourceObservationInput> = {}): SourceObservationInput {
  return {
    repoId: BigInt(REPO_ID),
    fullName: FULL_NAME,
    sourceSha: SOURCE_SHA.toUpperCase(),
    sourceRef: "refs/heads/main",
    path: PATH,
    allowedPaths: [PATH],
    ...overrides,
  };
}

test("숫자 repo identity를 검증하고 sourceRef가 아닌 exact source SHA에서 텍스트를 읽는다", async () => {
  const text = "{\"packageName\":\"com.seorilabs.sample\"}\n";
  const { octokit, calls } = fakeOctokit();
  const result = await readExactSourceFile(octokit, input());

  assert.equal(result.status, "PRESENT");
  if (result.status !== "PRESENT") return;
  assert.equal(result.text, text);
  assert.equal(result.repoId, REPO_ID);
  assert.equal(result.sourceSha, SOURCE_SHA);
  assert.equal(result.sourceRef, "refs/heads/main");
  assert.equal(result.blobSha, BLOB_SHA);
  assert.equal(result.size, Buffer.byteLength(text));
  assert.equal(
    result.contentSha256,
    createHash("sha256").update(Buffer.from(text)).digest("hex"),
  );
  assert.deepEqual(calls.repository, [{ owner: "seorilabs", repo: "sample-app" }]);
  assert.deepEqual(calls.source, [{
    owner: "seorilabs",
    repo: "sample-app",
    ref: SOURCE_SHA,
  }]);
  assert.deepEqual(calls.path, [{
    owner: "seorilabs",
    repo: "sample-app",
    path: PATH,
    ref: SOURCE_SHA,
  }]);
});

test("toSourceMetadata는 PRESENT 원문을 런타임 객체에서도 제거한다", async () => {
  const { octokit } = fakeOctokit();
  const result = await readExactSourceFile(octokit, input());
  assert.equal(result.status, "PRESENT");

  const metadata = toSourceMetadata(result);
  assert.equal("text" in metadata, false);
  assert.deepEqual(Object.keys(metadata).sort(), [
    "blobSha",
    "contentSha256",
    "fullName",
    "path",
    "reason",
    "repoId",
    "size",
    "sourceRef",
    "sourceSha",
    "status",
  ]);
  assert.equal(metadata.sourceRef, "refs/heads/main");
});

test("caller path allowlist 밖의 파일은 네트워크 요청 전 ACCESS_DENIED로 막는다", async () => {
  const { octokit, calls } = fakeOctokit();
  const result = await readExactSourceFile(octokit, input({ allowedPaths: ["package.json"] }));

  assert.equal(result.status, "ACCESS_DENIED");
  assert.equal(result.reason, "PATH_NOT_ALLOWED");
  assert.deepEqual(calls, { repository: [], source: [], path: [] });
  assert.equal(result.sourceRef, "refs/heads/main");
});

test("잘못된 exact SHA는 GitHub 요청 전 IDENTITY_MISMATCH로 막는다", async () => {
  const { octokit, calls } = fakeOctokit();
  const result = await readExactSourceFile(octokit, input({ sourceSha: "main" }));

  assert.equal(result.status, "IDENTITY_MISMATCH");
  assert.equal(result.reason, "INVALID_SOURCE_SHA");
  assert.deepEqual(calls, { repository: [], source: [], path: [] });
});

test("GitHub repository의 numeric ID 또는 canonical full name이 다르면 읽지 않는다", async (t) => {
  await t.test("numeric ID mismatch", async () => {
    const { octokit, calls } = fakeOctokit({
      repository: { id: REPO_ID + 1, full_name: FULL_NAME },
    });
    const result = await readExactSourceFile(octokit, input());
    assert.equal(result.status, "IDENTITY_MISMATCH");
    assert.equal(result.reason, "REPOSITORY_ID_MISMATCH");
    assert.equal(calls.source.length, 0);
    assert.equal(calls.path.length, 0);
  });

  await t.test("full name mismatch", async () => {
    const { octokit, calls } = fakeOctokit({
      repository: { id: REPO_ID, full_name: "seorilabs/other-app" },
    });
    const result = await readExactSourceFile(octokit, input());
    assert.equal(result.status, "IDENTITY_MISMATCH");
    assert.equal(result.reason, "REPOSITORY_FULL_NAME_MISMATCH");
    assert.equal(calls.source.length, 0);
    assert.equal(calls.path.length, 0);
  });
});

test("exact commit 조회 결과 SHA가 다르면 content를 읽지 않는다", async () => {
  const { octokit, calls } = fakeOctokit({ source: { sha: "c".repeat(40) } });
  const result = await readExactSourceFile(octokit, input());

  assert.equal(result.status, "IDENTITY_MISMATCH");
  assert.equal(result.reason, "SOURCE_SHA_MISMATCH");
  assert.equal(calls.path.length, 0);
});

test("GitHub 404와 403을 ABSENT와 ACCESS_DENIED로 구분한다", async (t) => {
  await t.test("404", async () => {
    const { octokit } = fakeOctokit({ content: httpError(404) });
    const result = await readExactSourceFile(octokit, input());
    assert.equal(result.status, "ABSENT");
    assert.equal(result.reason, "PATH_NOT_FOUND");
    assert.equal(result.sourceRef, "refs/heads/main");
  });

  await t.test("403", async () => {
    const { octokit } = fakeOctokit({ content: httpError(403) });
    const result = await readExactSourceFile(octokit, input());
    assert.equal(result.status, "ACCESS_DENIED");
    assert.equal(result.reason, "PATH_ACCESS_DENIED");
    assert.equal(result.sourceRef, "refs/heads/main");
  });
});

test("exact commit lookup 404는 파일 전체 부재가 아니라 source identity 불일치다", async () => {
  const { octokit } = fakeOctokit({ source: httpError(404) });
  const result = await readExactSourceFile(octokit, input());
  assert.equal(result.status, "IDENTITY_MISMATCH");
  assert.equal(result.reason, "SOURCE_NOT_FOUND");
});

test("등록 repository lookup 404는 파일 부재가 아니라 IAM uncertainty로 보존한다", async () => {
  const { octokit } = fakeOctokit({ repository: httpError(404) });
  const result = await readExactSourceFile(octokit, input());
  assert.equal(result.status, "ACCESS_DENIED");
  assert.equal(result.reason, "REPOSITORY_UNAVAILABLE");
});

test("directory 응답은 파일 부재로 오인하지 않고 INVALID_CONTENT로 태그한다", async () => {
  const { octokit } = fakeOctokit({ content: [] });
  const result = await readExactSourceFile(octokit, input());

  assert.equal(result.status, "INVALID_CONTENT");
  assert.equal(result.reason, "DIRECTORY");
});

test("비정상 base64와 UTF-8은 원문 없이 INVALID_CONTENT로 태그한다", async (t) => {
  await t.test("base64", async () => {
    const { octokit } = fakeOctokit({
      content: {
        type: "file",
        encoding: "base64",
        content: "@@==",
        sha: BLOB_SHA,
        size: 1,
      },
    });
    const result = await readExactSourceFile(octokit, input());
    assert.equal(result.status, "INVALID_CONTENT");
    assert.equal(result.reason, "INVALID_BASE64");
    assert.equal("text" in result, false);
  });

  await t.test("UTF-8", async () => {
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    const { octokit } = fakeOctokit({
      content: {
        type: "file",
        encoding: "base64",
        content: invalidUtf8.toString("base64"),
        sha: BLOB_SHA,
        size: invalidUtf8.byteLength,
      },
    });
    const result = await readExactSourceFile(octokit, input());
    assert.equal(result.status, "INVALID_CONTENT");
    assert.equal(result.reason, "INVALID_UTF8");
    assert.equal("text" in result, false);
  });
});

test("safe limit를 넘는 파일은 content를 디코드하지 않고 TOO_LARGE로 태그한다", async () => {
  const { octokit } = fakeOctokit({
    content: {
      type: "file",
      encoding: "none",
      sha: BLOB_SHA,
      size: SOURCE_OBSERVATION_MAX_BYTES + 1,
    },
  });
  const result = await readExactSourceFile(octokit, input());

  assert.equal(result.status, "TOO_LARGE");
  assert.equal(result.reason, "SIZE_LIMIT_EXCEEDED");
  assert.equal(result.size, SOURCE_OBSERVATION_MAX_BYTES + 1);
  assert.equal("text" in result, false);
});

test("명시적으로 allowlist한 lockfile만 absolute cap 안에서 큰 exact source를 읽는다", async () => {
  const text = "x".repeat(SOURCE_OBSERVATION_MAX_BYTES + 1);
  const { octokit } = fakeOctokit({
    content: {
      type: "file",
      encoding: "base64",
      content: Buffer.from(text, "utf8").toString("base64"),
      sha: BLOB_SHA,
      size: Buffer.byteLength(text),
    },
  });
  const result = await readExactSourceFile(octokit, input({
    path: "pnpm-lock.yaml",
    allowedPaths: ["pnpm-lock.yaml"],
    maxBytes: SOURCE_OBSERVATION_ABSOLUTE_MAX_BYTES,
  }));
  assert.equal(result.status, "PRESENT");
  if (result.status !== "PRESENT") return;
  assert.equal(result.size, SOURCE_OBSERVATION_MAX_BYTES + 1);

  const invalidOverride = await readExactSourceFile(octokit, input({
    path: "pnpm-lock.yaml",
    allowedPaths: ["pnpm-lock.yaml"],
    maxBytes: SOURCE_OBSERVATION_ABSOLUTE_MAX_BYTES + 1,
  }));
  assert.equal(invalidOverride.status, "TOO_LARGE");
});

test("빈 UTF-8 파일도 유효한 PRESENT 관측이다", async () => {
  const { octokit } = fakeOctokit({
    content: {
      type: "file",
      encoding: "base64",
      content: "",
      sha: BLOB_SHA,
      size: 0,
    },
  });
  const result = await readExactSourceFile(octokit, input());

  assert.equal(result.status, "PRESENT");
  if (result.status !== "PRESENT") return;
  assert.equal(result.text, "");
  assert.equal(result.size, 0);
});
