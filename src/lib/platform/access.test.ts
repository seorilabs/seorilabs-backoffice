import assert from "node:assert/strict";
import test from "node:test";

import {
  assertQueuedPlatformReadAccess,
  assertQueuedPlatformWriteAccess,
  assertPlatformReadAccess,
  assertPlatformWriteAccess,
} from "./access";

test("전역 read는 allowlisted ADMIN과 MAINTAINER만 허용한다", () => {
  assert.doesNotThrow(() =>
    assertPlatformReadAccess({ role: "ADMIN", allowlisted: true }),
  );
  assert.doesNotThrow(() =>
    assertPlatformReadAccess({ role: "MAINTAINER", allowlisted: true }),
  );
  assert.throws(
    () => assertPlatformReadAccess({ role: "VIEWER", allowlisted: true }),
    /조회 권한/,
  );
  assert.throws(
    () => assertPlatformReadAccess({ role: "ADMIN", allowlisted: false }),
    /조회 권한/,
  );
});

test("worker는 큐 actor와 활성 app 결합을 현재 권한으로 다시 확인한다", () => {
  const valid = {
    runAppId: "app-1",
    runActorLogin: "maintainer",
    requestedAppSlug: "lizard-tycoon",
    app: {
      id: "app-1",
      slug: "lizard-tycoon",
      platformAppId: null,
      active: true,
    },
    user: {
      id: "user-1",
      login: "maintainer",
      role: "MAINTAINER" as const,
      allowlisted: true,
      isAppOwner: true,
    },
  };
  assert.doesNotThrow(() => assertQueuedPlatformWriteAccess(valid));
  assert.doesNotThrow(() =>
    assertQueuedPlatformReadAccess({
      ...valid,
      user: { ...valid.user, isAppOwner: false },
    }),
  );
  assert.throws(
    () =>
      assertQueuedPlatformWriteAccess({
        ...valid,
        requestedAppSlug: "other-app",
      }),
    /앱 결합/,
  );
  assert.throws(
    () =>
      assertQueuedPlatformWriteAccess({
        ...valid,
        runActorLogin: "forged-actor",
      }),
    /운영자 권한/,
  );
  assert.throws(
    () =>
      assertQueuedPlatformWriteAccess({
        ...valid,
        app: { ...valid.app, active: false },
      }),
    /활성 상태/,
  );
});

test("worker는 저장소 slug가 아니라 바인딩된 Platform app ID를 검증한다", () => {
  const valid = {
    runAppId: "app-saju",
    runActorLogin: "maintainer",
    requestedAppSlug: "ungeul",
    app: {
      id: "app-saju",
      slug: "saju-reader",
      platformAppId: "ungeul",
      active: true,
    },
    user: {
      id: "user-1",
      login: "maintainer",
      role: "MAINTAINER" as const,
      allowlisted: true,
      isAppOwner: true,
    },
  };

  assert.doesNotThrow(() => assertQueuedPlatformWriteAccess(valid));
  assert.throws(
    () =>
      assertQueuedPlatformWriteAccess({
        ...valid,
        requestedAppSlug: "saju-reader",
      }),
    /앱 결합/,
  );
});

test("write는 ADMIN 또는 해당 앱 owner인 MAINTAINER만 허용한다", () => {
  assert.doesNotThrow(() =>
    assertPlatformWriteAccess({
      role: "ADMIN",
      allowlisted: true,
      isAppOwner: false,
    }),
  );
  assert.doesNotThrow(() =>
    assertPlatformWriteAccess({
      role: "MAINTAINER",
      allowlisted: true,
      isAppOwner: true,
    }),
  );
  assert.throws(
    () =>
      assertPlatformWriteAccess({
        role: "MAINTAINER",
        allowlisted: true,
        isAppOwner: false,
      }),
    /변경 권한/,
  );
  assert.throws(
    () =>
      assertPlatformWriteAccess({
        role: "VIEWER",
        allowlisted: true,
        isAppOwner: true,
      }),
    /조회 권한/,
  );
});
