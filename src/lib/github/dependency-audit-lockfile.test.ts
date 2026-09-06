import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readDependencyAuditLockfile } from "@/lib/github/dependency-audit-lockfile";

const SOURCE_SHA = "a".repeat(40);
const input = {
  repositoryId: "1250442131", fullName: "seorilabs/happy-farm", sourceSha: SOURCE_SHA,
  dependencyRoot: "app", packageManager: "pnpm" as const,
};

test("lockfile digest는 exact repository와 commit의 실제 UTF-8 bytes로 계산한다", async () => {
  const bytes = Buffer.from("lockfileVersion: '9.0'\n# 한글\n", "utf8");
  for (const packageManager of ["pnpm", "npm"] as const) {
    const client = {
      rest: { repos: {
        async get() { return { data: { id: 1250442131, full_name: input.fullName } }; },
        async getCommit(request: { ref: string }) {
          assert.equal(request.ref, SOURCE_SHA);
          return { data: { sha: SOURCE_SHA } };
        },
        async getContent(request: { path: string; ref: string }) {
          assert.equal(request.ref, SOURCE_SHA);
          assert.equal(request.path, packageManager === "pnpm" ? "app/pnpm-lock.yaml" : "app/package-lock.json");
          return { data: {
            type: "file", encoding: "base64", content: bytes.toString("base64"),
            size: bytes.length, sha: "b".repeat(40),
          } };
        },
      } },
    };
    assert.equal(await readDependencyAuditLockfile({ ...input, packageManager }, client as never),
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  }
});

test("lockfile 조회는 경로 탈출과 다른 repository identity를 허용하지 않는다", async () => {
  const client = {
    rest: { repos: {
      async get() { return { data: { id: 1, full_name: input.fullName } }; },
      async getCommit() { throw new Error("must not read source"); },
      async getContent() { throw new Error("must not read content"); },
    } },
  };
  for (const dependencyRoot of ["app", "../app", "app/../other", "/app", "app/./other"]) {
    assert.equal(await readDependencyAuditLockfile({ ...input, dependencyRoot }, client as never), null);
  }
});
