import assert from "node:assert/strict";
import test from "node:test";
import { appVisibilitySchema, assertAppVisibilityAccess, assertAppVisibilityVersion } from "./app-visibility-service";

test("AC-4: allowlist와 앱 OWNER 범위를 벗어난 운영 상태 변경은 거부한다", () => {
  assert.doesNotThrow(() => assertAppVisibilityAccess({role: "ADMIN", allowlisted: true, isOwner: false}));
  assert.doesNotThrow(() => assertAppVisibilityAccess({role: "MAINTAINER", allowlisted: true, isOwner: true}));
  for (const subject of [
    {role: "VIEWER", allowlisted: true, isOwner: true},
    {role: "MAINTAINER", allowlisted: true, isOwner: false},
    {role: "ADMIN", allowlisted: false, isOwner: true},
  ] as const) assert.throws(() => assertAppVisibilityAccess(subject), /권한/);
});

test("AC-4: 오래된 앱 갱신 시각으로 숨김을 덮어쓰지 않는다", () => {
  const actual = new Date("2026-10-12T10:00:00.000Z");
  assert.doesNotThrow(() => assertAppVisibilityVersion(actual, actual.toISOString()));
  assert.throws(() => assertAppVisibilityVersion(actual, "2026-10-12T09:59:59.999Z"), /최신/);
});

test("AC-4: 대상·사유·버전을 빠뜨리거나 알 수 없는 입력을 넣으면 거부한다", () => {
  const request = {appId: "app-a", status: "DEPRECATED", expectedUpdatedAt: "2026-10-12T10:00:00.000Z", reason: "목록에서 숨김"};
  assert.equal(appVisibilitySchema.safeParse(request).success, true);
  for (const bad of [{...request, appId: ""}, {...request, reason: " "}, {...request, expectedUpdatedAt: "bad"}, {...request, actor: "admin"}]) {
    assert.equal(appVisibilitySchema.safeParse(bad).success, false);
  }
});
