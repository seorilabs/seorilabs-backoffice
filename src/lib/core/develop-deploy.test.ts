import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDevelopDeployInputs,
  nextDevelopCandidateTag,
  parseDevelopCandidateTag,
  resolveDevelopDeployDispatchRef,
  resolveDevelopCandidateBase,
} from "@/lib/core/develop-candidate";

test("후보 태그는 마지막 stable SemVer에 develop 순번을 이어 붙인다", () => {
  assert.equal(
    nextDevelopCandidateTag("v1.2.3", [
      "v1.2.3",
      "v1.2.3-develop.1",
      "v1.2.3-develop.3",
      "v1.2.2-develop.99",
      "legacy-10",
    ]),
    "v1.2.3-develop.4",
  );
  assert.deepEqual(parseDevelopCandidateTag("v1.2.3-develop.4"), {
    baseTag: "v1.2.3",
    sequence: 4,
  });
  assert.equal(parseDevelopCandidateTag("v1.2.3-develop.0"), null);
  assert.equal(parseDevelopCandidateTag("v1.2.3-rc.1"), null);
});

test("표준 caller는 기본 브랜치에서 후보 태그를 입력받고 레거시는 develop에서만 실행한다", () => {
  assert.equal(
    resolveDevelopDeployDispatchRef("main", new Set(["release_tag"]), "v1.2.3-develop.1"),
    "main",
  );
  assert.equal(
    resolveDevelopDeployDispatchRef("develop", new Set(), "v0.1.0-develop.1"),
    "v0.1.0-develop.1",
  );
  assert.throws(
    () => resolveDevelopDeployDispatchRef("main", new Set(), "v1.2.3-develop.1"),
    /develop 소스를 고정/,
  );
});

test("태그가 없으면 develop package version을 쓰고 마켓 원장이 더 높으면 우선한다", () => {
  assert.equal(
    resolveDevelopCandidateBase({ tags: [], packageVersion: "0.1.0" }),
    "v0.1.0",
  );
  assert.equal(
    resolveDevelopCandidateBase({
      tags: ["v1.1.9", "legacy"],
      marketFloor: "v1.2.0",
      packageVersion: "1.0.0",
    }),
    "v1.2.0",
  );
  assert.throws(
    () => resolveDevelopCandidateBase({ tags: ["legacy"], packageVersion: "next" }),
    /후보 버전/,
  );
});

test("표준·레거시 AIT caller에는 선언된 develop 배포 입력만 보낸다", () => {
  assert.deepEqual(
    buildDevelopDeployInputs(
      new Set(["release_tag", "memo"]),
      "v1.2.3-develop.2",
      "1234567890abcdef",
    ),
    {
      release_tag: "v1.2.3-develop.2",
      memo: "develop candidate v1.2.3-develop.2 (1234567)",
    },
  );
  assert.deepEqual(
    buildDevelopDeployInputs(
      new Set(["memo", "create_release_tag"]),
      "v0.1.0-develop.1",
      "abcdef0123456789",
    ),
    {
      memo: "develop candidate v0.1.0-develop.1 (abcdef0)",
      create_release_tag: "false",
    },
  );
});
