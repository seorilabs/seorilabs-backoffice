import assert from "node:assert/strict";
import test from "node:test";

import { assertReleaseWriteAccess } from "@/lib/core/release-access";

test("릴리스 write는 allowlisted ADMIN 또는 앱 OWNER인 MAINTAINER만 허용한다", () => {
  assert.doesNotThrow(() =>
    assertReleaseWriteAccess({ role: "ADMIN", allowlisted: true, isAppOwner: false }),
  );
  assert.doesNotThrow(() =>
    assertReleaseWriteAccess({ role: "MAINTAINER", allowlisted: true, isAppOwner: true }),
  );

  for (const subject of [
    { role: "VIEWER" as const, allowlisted: true, isAppOwner: true },
    { role: "MAINTAINER" as const, allowlisted: true, isAppOwner: false },
    { role: "ADMIN" as const, allowlisted: false, isAppOwner: true },
  ]) {
    assert.throws(() => assertReleaseWriteAccess(subject), /릴리스 운영 권한/u);
  }
});
