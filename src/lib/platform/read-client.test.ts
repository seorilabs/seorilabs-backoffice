import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { platformReadConfiguration } from "./read-client";

const KEYS = [
  "FEATURE_PLATFORM_ADMIN",
  "PLATFORM_ADMIN_URL",
  "PLATFORM_ADMIN_READ_SA_KEY_JSON",
] as const;

const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("플랫폼 조회 연결 상태", () => {
  it("기능 플래그가 꺼지면 비활성이다", () => {
    delete process.env.FEATURE_PLATFORM_ADMIN;
    assert.deepEqual(platformReadConfiguration(), {
      enabled: false,
      configured: false,
      message: "플랫폼 관리 기능이 비활성화되어 있습니다.",
    });
  });

  it("read identity까지 있어야 준비 상태다", () => {
    process.env.FEATURE_PLATFORM_ADMIN = "true";
    process.env.PLATFORM_ADMIN_URL = "https://platform-admin.test";
    delete process.env.PLATFORM_ADMIN_READ_SA_KEY_JSON;
    assert.equal(platformReadConfiguration().configured, false);

    process.env.PLATFORM_ADMIN_READ_SA_KEY_JSON = "{}";
    assert.equal(platformReadConfiguration().configured, true);
  });
});
