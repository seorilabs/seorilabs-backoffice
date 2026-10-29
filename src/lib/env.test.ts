import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseSlackRetentionDays } from "@/lib/env";
import { CHANNEL_DESTINATIONS } from "@/lib/notifications/destinations";
import { capabilitiesForRole } from "@/lib/operator/roles";

const envExample = readFileSync(join(process.cwd(), ".env.example"), "utf8");
const envModule = readFileSync(join(process.cwd(), "src/lib/env.ts"), "utf8");

test("Slack 보존일은 기본값과 1~365일 정수 범위로 제한한다", () => {
  assert.equal(parseSlackRetentionDays(undefined), 30);
  assert.equal(parseSlackRetentionDays("invalid"), 30);
  assert.equal(parseSlackRetentionDays("Infinity"), 30);
  assert.equal(parseSlackRetentionDays("0"), 1);
  assert.equal(parseSlackRetentionDays("7.9"), 7);
  assert.equal(parseSlackRetentionDays("999"), 365);
});

test(".env.example은 Telegram 키를 남기지 않고 env가 읽는 Slack 키를 모두 문서화한다", () => {
  assert.doesNotMatch(envExample, /TELEGRAM/);

  // env.ts가 리터럴로 읽는 키와 접두사 조합으로 만드는 키를 모두 모은다.
  const literal = [...envModule.matchAll(/(?:optional|required)\("(SLACK_[A-Z_0-9]+)"/g)]
    .map((match) => match[1]);
  const channels = [...envExample.matchAll(/^(SLACK_CHANNEL_[A-Z_0-9]+)=/gm)].map((m) => m[1]);
  const roles = [...envExample.matchAll(/^(SLACK_ROLE_[A-Z_0-9]+_USERS)=/gm)].map((m) => m[1]);

  for (const key of literal) {
    assert.match(envExample, new RegExp(`^${key}=`, "m"), `${key} 누락`);
  }
  // 목적지와 역할이 모두 있어야 배달과 권한 판정이 로컬에서 재현된다. 개수를 숫자로
  // 박으면 목적지가 늘 때마다 숫자만 고치게 되므로 정본과 집합을 대조한다.
  const envKey = (key: string) => `SLACK_CHANNEL_${key.toUpperCase().replace(/-/g, "_")}_ID`;
  assert.deepEqual(
    [...channels].sort(),
    CHANNEL_DESTINATIONS.map(envKey).sort(),
  );
  // roles.ts 의 역할 키는 env 가 있어야 의미가 있다. env 없는 키는 capability 판정에서
  // 영원히 false 라 목록에 두면 안 되고, env 만 있고 키가 없으면 주입이 낭비다.
  const roleKeys = roles.map((key) =>
    key.slice("SLACK_ROLE_".length).replace(/_USERS$/, "").toLowerCase(),
  );
  for (const key of roleKeys) {
    assert.ok(capabilitiesForRole(key).length > 0, `${key} 역할이 roles.ts 에 없다`);
  }
  assert.equal(roles.length, 10);
});
