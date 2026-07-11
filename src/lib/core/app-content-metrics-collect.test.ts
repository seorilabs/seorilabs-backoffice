import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyContentTargets,
  buildContentUpsert,
  type ContentCollectAppRow,
} from "@/lib/core/app-content-metrics-collect";
import type { ContentMetricSnapshot } from "@/lib/analytics/content-source";

// 범용(스펙 구동) 컨텐츠 지표 수집의 결정 로직(대상 분류 / upsert 페이로드)을 DB 없이
// 순수 검증한다. (repo 관례: collect 는 pure 헬퍼만 유닛테스트, DB 오케스트레이션 제외.)

const lucid: ContentCollectAppRow = {
  id: "app_lucid",
  slug: "lucid-chess", // 컨텐츠 스펙 등록됨 + GA4 fallback 대상 존재.
  firebaseProject: null,
  ga4Dataset: null,
};
const noSpec: ContentCollectAppRow = {
  id: "app_x",
  slug: "no-such-game", // 컨텐츠 스펙 미등록 → skipped.
  firebaseProject: "p",
  ga4Dataset: "analytics_1",
};

test("classifyContentTargets: 스펙+GA4대상 앱만 target, 나머지는 skipped", () => {
  const { targets, skipped } = classifyContentTargets([lucid, noSpec]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].app.slug, "lucid-chess");
  assert.equal(targets[0].spec.slug, "lucid-chess");
  assert.ok(targets[0].target.firebaseProject);
  assert.ok(targets[0].target.dataset);
  assert.deepEqual(skipped, ["no-such-game"]);
});

test("classifyContentTargets: DB 의 firebaseProject/dataset 이 fallback 보다 우선", () => {
  const overridden: ContentCollectAppRow = {
    id: "app_lucid",
    slug: "lucid-chess",
    firebaseProject: "custom-proj",
    ga4Dataset: "analytics_custom",
  };
  const { targets } = classifyContentTargets([overridden]);
  assert.equal(targets[0].target.firebaseProject, "custom-proj");
  assert.equal(targets[0].target.dataset, "analytics_custom");
});

test("classifyContentTargets: 빈 입력은 빈 결과(공통 지표에 영향 없음)", () => {
  const { targets, skipped } = classifyContentTargets([]);
  assert.deepEqual(targets, []);
  assert.deepEqual(skipped, []);
});

test("buildContentUpsert: totalEvents + raw 스냅샷 + collectedAt 잠금", () => {
  const snap: ContentMetricSnapshot = {
    metrics: { hint: { value: 5, users: 3 }, avg_moves: { value: 40 } },
    distributions: { outcome: [{ k: "win", count: 3, users: 2 }] },
    groups: { level: { "1": { starts: { value: 20, users: 15 } } } },
    totalEvents: 12,
  };
  const now = new Date("2026-07-11T00:00:00.000Z");
  const data = buildContentUpsert(snap, now);
  assert.equal(data.totalEvents, 12);
  assert.equal(data.collectedAt, now);
  assert.deepEqual(data.raw, snap);
});
