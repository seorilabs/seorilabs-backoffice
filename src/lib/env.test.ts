import assert from "node:assert/strict";
import test from "node:test";
import { parseDiscordRetentionDays } from "@/lib/env";

test("Discord 보존일은 기본값과 1~365일 정수 범위로 제한한다", () => {
  assert.equal(parseDiscordRetentionDays(undefined), 30);
  assert.equal(parseDiscordRetentionDays("invalid"), 30);
  assert.equal(parseDiscordRetentionDays("Infinity"), 30);
  assert.equal(parseDiscordRetentionDays("0"), 1);
  assert.equal(parseDiscordRetentionDays("7.9"), 7);
  assert.equal(parseDiscordRetentionDays("999"), 365);
});
