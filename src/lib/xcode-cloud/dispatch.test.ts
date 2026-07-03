import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { isXcodeCloudRepo } from "./dispatch";

const KEY = "XCODE_CLOUD_APP_STORE_REPOS";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

test("allowlist(CSV) 에 있는 repo 는 Xcode Cloud 대상", () => {
  process.env[KEY] = "seorilabs/happy-farm, seorilabs/foo";
  assert.equal(isXcodeCloudRepo("seorilabs/happy-farm"), true);
  assert.equal(isXcodeCloudRepo("seorilabs/foo"), true);
});

test("allowlist 에 없는 repo 는 대상 아님", () => {
  process.env[KEY] = "seorilabs/happy-farm";
  assert.equal(isXcodeCloudRepo("seorilabs/other"), false);
});

test("미설정/빈 allowlist 는 전부 대상 아님", () => {
  delete process.env[KEY];
  assert.equal(isXcodeCloudRepo("seorilabs/happy-farm"), false);
  process.env[KEY] = "";
  assert.equal(isXcodeCloudRepo("seorilabs/happy-farm"), false);
});
