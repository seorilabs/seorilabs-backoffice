import assert from "node:assert/strict";
import test from "node:test";
import { resolveGa4Target, parseWindowDays } from "@/lib/ga4/datasets";

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

test("parseWindowDays 는 기본 수집과 제한된 백필 범위를 구분한다", () => {
  assert.equal(parseWindowDays(null), undefined);
  assert.equal(parseWindowDays("90"), 90);
  assert.throws(() => parseWindowDays("0"), /1~366/);
  assert.throws(() => parseWindowDays("367"), /1~366/);
  assert.throws(() => parseWindowDays("1.5"), /양의 정수/);
});
