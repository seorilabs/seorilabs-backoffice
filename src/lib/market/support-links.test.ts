import test from "node:test";
import assert from "node:assert/strict";
import { checkPublicLink, publicLinkTarget } from "./support-links";
test("지원 링크는 로컬 주소·HTTP·사용자 인증·다른 포트를 허용하지 않음", async () => {
  for (const url of [
    "https://127.0.0.1",
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com:8443",
  ])
    await assert.rejects(checkPublicLink(url));
});
test("긴 지원 URL은 충돌 없는 제한된 target으로 저장함", () => {
  const a = "https://example.com/support?q=" + "a".repeat(1900);
  const b = a + "b";
  assert.ok(publicLinkTarget(a).length <= 191);
  assert.equal(publicLinkTarget(a), publicLinkTarget(a));
  assert.notEqual(publicLinkTarget(a), publicLinkTarget(b));
});
