import assert from "node:assert/strict";
import test from "node:test";
import { marketingVersionFromTag } from "@/lib/app-store/submit";
import { RELEASE_NOTE_LOCALES } from "@/lib/core/release-note-locales";

test("marketingVersionFromTag: v 접두사 제거, 숫자 버전 유지", () => {
  assert.equal(marketingVersionFromTag("v1.2.3"), "1.2.3");
  assert.equal(marketingVersionFromTag("V2.0.0"), "2.0.0");
  assert.equal(marketingVersionFromTag("1.4.5"), "1.4.5");
  assert.equal(marketingVersionFromTag("  v1.0.0  "), "1.0.0");
});

test("모든 로케일에 App Store 로케일 코드가 있고 서로 유일하다", () => {
  const asc = RELEASE_NOTE_LOCALES.map((l) => l.ascLocale);
  assert.ok(asc.every((c) => c.length > 0));
  assert.equal(new Set(asc).size, asc.length, "ascLocale 중복 없음");
  // 스토어 코드 체계 차이 회귀 방지(Play zh-CN → ASC zh-Hans 등).
  const byField = Object.fromEntries(
    RELEASE_NOTE_LOCALES.map((l) => [l.field, l.ascLocale]),
  );
  assert.equal(byField.koKR, "ko");
  assert.equal(byField.zhCN, "zh-Hans");
  assert.equal(byField.zhTW, "zh-Hant");
  assert.equal(byField.jaJP, "ja");
});
