import assert from "node:assert/strict";
import test from "node:test";
import { kstClock, kstDateShort, kstDateTime, kstDateTimeShort, kstLogStamp } from "@/lib/format/kst";

// 시각 표기는 기계 타임존과 무관해야 한다. Intl 에 timeZone 을 고정해 두었으므로
// 아래 기대값은 어느 러너에서 돌려도 같다.
const AT = new Date("2026-09-16T05:53:35.000Z"); // 2026-09-16 14:53:35 KST

test("본문 절대 시각은 ko-KR·KST 한 가지 표기로 나간다", () => {
  const text = kstDateTime(AT);
  assert.match(text, /2026/);
  assert.match(text, /9\./);
  assert.match(text, /16\./);
  assert.match(text, /2:53:35/);
  // raw ISO 가 섞여 나가던 것을 없앤 자리다.
  assert.equal(/\d{4}-\d{2}-\d{2}T/.test(text), false);
});

test("기록용 시계는 24시간 표기로 초까지 남긴다", () => {
  assert.equal(kstClock(AT), "14:53:35");
});

test("로그 시각은 같은 KST 날이면 시각만, 다른 날이면 날짜를 붙인다", () => {
  assert.equal(kstLogStamp(AT, new Date("2026-09-16T10:00:00.000Z")), "14:53");
  assert.equal(kstLogStamp(AT, new Date("2026-09-17T05:00:00.000Z")), "09-16 14:53");
  // KST 자정 경계. UTC 15:00 부터 다음 날이다.
  const justBefore = new Date("2026-09-16T14:59:59.000Z");
  assert.equal(kstLogStamp(justBefore, new Date("2026-09-16T15:30:00.000Z")), "09-16 23:59");
});

test("화면 표 셀은 값이 없으면 대시를 낸다", () => {
  assert.equal(kstDateTimeShort(null), "—");
  assert.equal(kstDateShort(undefined), "—");
  // 화면 표 셀 표기는 이전 fmtDateTime·fmtDate 와 글자까지 같다. 옮기기만 했다.
  assert.equal(kstDateTimeShort(AT), "2026. 09. 16. 오후 02:53");
  assert.equal(kstDateShort(AT), "09. 16.");
});
