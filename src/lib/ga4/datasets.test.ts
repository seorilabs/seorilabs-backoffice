import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveGa4Target,
  toTableSuffix,
  isoDate,
  parseIsoDate,
  latestClosedDay,
  dateWindow,
  daysBetween,
  parseWindowDays,
} from "@/lib/ga4/datasets";

test("resolveGa4Target 는 DB 값(firebaseProject+ga4Dataset)을 우선한다", () => {
  const t = resolveGa4Target({
    slug: "happy-farm",
    firebaseProject: "custom-proj",
    ga4Dataset: "analytics_999",
  });
  assert.deepEqual(t, { firebaseProject: "custom-proj", dataset: "analytics_999" });
});

test("resolveGa4Target 는 DB 값이 없으면 fallback 표를 쓴다", () => {
  const t = resolveGa4Target({ slug: "lucid-chess", firebaseProject: null, ga4Dataset: null });
  assert.deepEqual(t, {
    firebaseProject: "lucid-chess-dbb9d",
    dataset: "analytics_539665867",
  });
});

test("resolveGa4Target 는 foam-party fallback 매핑을 반환한다(키 오타/dataset 회귀 방지)", () => {
  const t = resolveGa4Target({ slug: "foam-party", firebaseProject: null, ga4Dataset: null });
  assert.deepEqual(t, {
    firebaseProject: "foam-party",
    dataset: "analytics_542197312",
  });
});

test("resolveGa4Target 는 match-picture-app fallback 매핑을 반환한다", () => {
  const t = resolveGa4Target({ slug: "match-picture-app", firebaseProject: null, ga4Dataset: null });
  assert.deepEqual(t, {
    firebaseProject: "match-picture-app",
    dataset: "analytics_542397319",
  });
});

test("resolveGa4Target 는 slotmachine-game export 매핑을 반환한다", () => {
  const t = resolveGa4Target({
    slug: "slotmachine-game",
    firebaseProject: "slotmachine-game-495cc",
    ga4Dataset: null,
  });
  assert.deepEqual(t, {
    firebaseProject: "slotmachine-game-495cc",
    dataset: "analytics_547294653",
  });
});

test("resolveGa4Target 는 lizard-tycoon export 매핑을 반환한다", () => {
  assert.deepEqual(
    resolveGa4Target({ slug: "lizard-tycoon", firebaseProject: "lizard-tycoon", ga4Dataset: null }),
    { firebaseProject: "lizard-tycoon", dataset: "analytics_544016233" },
  );
});

test("resolveGa4Target 는 출시 앱의 검증된 export 매핑을 반환한다", () => {
  assert.deepEqual(
    resolveGa4Target({ slug: "babycare", firebaseProject: null, ga4Dataset: null }),
    { firebaseProject: "seorilabs-babycare", dataset: "analytics_549232169" },
  );
  assert.deepEqual(
    resolveGa4Target({ slug: "spiritgate-defenders", firebaseProject: null, ga4Dataset: null }),
    { firebaseProject: "spiritgate-defenders", dataset: "analytics_549931858" },
  );
});

test("resolveGa4Target 는 매핑 없는 앱에 null 을 준다", () => {
  assert.equal(
    resolveGa4Target({ slug: "unknown-app", firebaseProject: null, ga4Dataset: null }),
    null,
  );
});

test("날짜 유틸: suffix/iso 변환과 왕복", () => {
  const d = parseIsoDate("2026-07-04");
  assert.equal(isoDate(d), "2026-07-04");
  assert.equal(toTableSuffix(d), "20260704");
});

test("latestClosedDay 는 D-1(어제 UTC 자정)", () => {
  const now = new Date("2026-07-05T13:00:00.000Z");
  assert.equal(isoDate(latestClosedDay(now)), "2026-07-04");
});

test("dateWindow 는 오래된→최신 순으로 days 개", () => {
  const end = parseIsoDate("2026-07-04");
  const w = dateWindow(end, 3).map(isoDate);
  assert.deepEqual(w, ["2026-07-02", "2026-07-03", "2026-07-04"]);
});

test("daysBetween 은 두 날짜의 일수 차", () => {
  assert.equal(daysBetween(parseIsoDate("2026-07-04"), parseIsoDate("2026-07-01")), 3);
  assert.equal(daysBetween(parseIsoDate("2026-07-04"), parseIsoDate("2026-07-04")), 0);
});

test("parseWindowDays 는 기본 수집과 제한된 백필 범위를 구분한다", () => {
  assert.equal(parseWindowDays(null), undefined);
  assert.equal(parseWindowDays("90"), 90);
  assert.throws(() => parseWindowDays("0"), /1~366/);
  assert.throws(() => parseWindowDays("367"), /1~366/);
  assert.throws(() => parseWindowDays("1.5"), /양의 정수/);
});
