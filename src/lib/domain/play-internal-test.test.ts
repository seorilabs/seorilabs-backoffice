import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePlayInternalTestUrl,
  playInternalTestLink,
} from "@/lib/domain/play-internal-test";

const OPT_IN = "https://play.google.com/apps/internaltest/4700123456789012345";

test("내부 테스트 링크를 입력하면 그대로 저장한다", () => {
  assert.deepEqual(parsePlayInternalTestUrl(OPT_IN), { ok: true, url: OPT_IN });
  // 붙여넣기로 딸려 오는 공백은 저장 전에 정리한다.
  assert.deepEqual(parsePlayInternalTestUrl(`  ${OPT_IN}\n`), { ok: true, url: OPT_IN });
});

test("다른 Play 링크로 수정할 수 있다", () => {
  const other = "https://play.google.com/store/apps/details?id=com.seorilabs.happyfarm&hl=ko";
  assert.deepEqual(parsePlayInternalTestUrl(other), { ok: true, url: other });
});

test("비우면 삭제로 보고 null 을 저장한다", () => {
  for (const empty of ["", "   ", "\n", null, undefined]) {
    assert.deepEqual(parsePlayInternalTestUrl(empty), { ok: true, url: null }, String(empty));
  }
});

test("Play 링크가 아니면 저장을 거부한다", () => {
  for (const invalid of [
    "http://play.google.com/apps/internaltest/1",
    "https://play.google.com.evil.example/apps/internaltest/1",
    "https://evil.example/apps/internaltest/1",
    "javascript:alert(1)",
    "play.google.com/apps/internaltest/1",
  ]) {
    const parsed = parsePlayInternalTestUrl(invalid);
    assert.equal(parsed.ok, false, invalid);
  }
});

test("카드 렌더는 저장 규칙과 같은 판정을 쓴다", () => {
  assert.equal(playInternalTestLink(OPT_IN), OPT_IN);
  assert.equal(playInternalTestLink(`  ${OPT_IN}  `), OPT_IN);
  // 규칙 이전에 들어간 값이나 빈 값은 버튼을 만들지 않는다.
  for (const invalid of ["", null, undefined, "https://evil.example/x"]) {
    assert.equal(playInternalTestLink(invalid), null, String(invalid));
  }
});
