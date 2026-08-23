import assert from "node:assert/strict";
import test from "node:test";
import {
  bumpStableSemVerTag,
  compareStableSemVerTagsDesc,
  normalizeStableSemVerTag,
  parseStableSemVerTag,
} from "./stable-semver";

test("stable SemVer 태그만 파싱한다", () => {
  assert.deepEqual(parseStableSemVerTag("v1.0.12"), [1, 0, 12]);
  assert.deepEqual(parseStableSemVerTag("1.0.12"), [1, 0, 12]);
  assert.equal(parseStableSemVerTag("v27.1"), null);
  assert.equal(parseStableSemVerTag("v27.1.NaN"), null);
  assert.equal(parseStableSemVerTag("v01.0.0"), null);
  assert.equal(parseStableSemVerTag("v1.0.12-develop.1"), null);
});

test("레거시 태그를 증가시키지 않고 명시적으로 거부한다", () => {
  assert.equal(bumpStableSemVerTag("v1.0.11", "patch"), "v1.0.12");
  assert.equal(bumpStableSemVerTag(null, "patch"), "v0.0.1");
  assert.throws(() => bumpStableSemVerTag("v27.1", "patch"), /SemVer/);
  assert.throws(() => bumpStableSemVerTag("v27.1.NaN", "patch"), /SemVer/);
});

test("stable SemVer를 정규화하고 내림차순 비교한다", () => {
  assert.equal(normalizeStableSemVerTag("1.2.3"), "v1.2.3");
  assert.equal(compareStableSemVerTagsDesc("v1.0.12", "v1.0.11"), -1);
  assert.equal(compareStableSemVerTagsDesc("v1.0.11", "v1.0.12"), 1);
});
