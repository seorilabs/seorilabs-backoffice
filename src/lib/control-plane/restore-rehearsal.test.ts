import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIsolatedRehearsalDatabaseUrl,
  isolatedRehearsalDatabaseUrl,
} from "@/lib/control-plane/restore-rehearsal";

test("restore rehearsal DB는 loopback의 고정 격리 database만 허용한다", () => {
  const url = isolatedRehearsalDatabaseUrl({ host: "127.0.0.1", password: "temporary-pass" });
  assert.doesNotThrow(() => assertIsolatedRehearsalDatabaseUrl(url));
  for (const unsafe of [
    "mysql://root:x@mysql.data.svc.cluster.local:3306/backoffice",
    "mysql://root:x@127.0.0.1:3306/backoffice",
    "postgresql://root:x@127.0.0.1:5432/backoffice_rehearsal",
  ]) {
    assert.throws(() => assertIsolatedRehearsalDatabaseUrl(unsafe), /REHEARSAL_DATABASE_NOT_ISOLATED/);
  }
});

test("ephemeral password는 URL encoding하고 newline을 거부한다", () => {
  const url = isolatedRehearsalDatabaseUrl({ host: "localhost", password: "a:b/@c", port: 13306 });
  assert.match(url, /a%3Ab%2F%40c/);
  assert.match(url, /:13306\/backoffice_rehearsal/);
  assert.throws(
    () => isolatedRehearsalDatabaseUrl({ host: "localhost", password: "bad\nvalue" }),
    /REHEARSAL_DATABASE_PASSWORD_INVALID/,
  );
});
