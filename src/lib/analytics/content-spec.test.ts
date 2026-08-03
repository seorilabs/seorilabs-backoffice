import assert from "node:assert/strict";
import test from "node:test";
import { specEvents, assertIdent, type AppContentSpec } from "@/lib/analytics/content-spec";
import { contentSpecFor, contentSpecSlugs } from "@/lib/analytics/content-registry";
import { buildContentSql } from "@/lib/analytics/content-sql";

test("specEvents: metrics/distributions/groups 의 event 를 중복 없이 모은다(배열 포함)", () => {
  const spec: AppContentSpec = {
    slug: "x",
    metrics: [{ key: "s", label: "", event: ["a", "b"], agg: "count" }],
    distributions: [{ key: "d", label: "", event: "game_end", param: "outcome" }],
    groups: [{ key: "g", label: "", param: "level", metrics: [{ key: "c", label: "", event: "game_end", agg: "count" }] }],
  };
  assert.deepEqual(specEvents(spec).sort(), ["a", "b", "game_end"]);
});

test("assertIdent: 규격 밖 식별자는 던진다", () => {
  assert.equal(assertIdent("game_end", "event"), "game_end");
  assert.throws(() => assertIdent("a b", "event"), /식별자 규격 위반/);
  assert.throws(() => assertIdent("x'; DROP", "event"), /식별자 규격 위반/);
});

test("registry: 4개 게임 스펙이 등록되어 있다", () => {
  for (const slug of ["lucid-chess", "happy-farm", "foam-party", "crossword-puzzle"]) {
    assert.ok(contentSpecFor(slug), `${slug} 스펙 등록됨`);
    assert.ok(contentSpecSlugs().includes(slug));
  }
  assert.equal(contentSpecFor("no-such-app"), null);
});

test("registry: 모든 등록 스펙이 SQL 조립을 통과한다(식별자/값 규격 위반 없음)", () => {
  for (const slug of contentSpecSlugs()) {
    const spec = contentSpecFor(slug)!;
    assert.doesNotThrow(
      () => buildContentSql(spec, "`p.d.events_*`", "20260101", "20260107"),
      `${slug} SQL 조립 실패`,
    );
  }
});

test("registry: crossword/foam 은 마켓, happy-farm/lucid-chess 는 비마켓", () => {
  assert.ok(contentSpecFor("crossword-puzzle")!.market);
  assert.ok(contentSpecFor("foam-party")!.market);
  assert.equal(contentSpecFor("happy-farm")!.market, undefined);
  assert.equal(contentSpecFor("lucid-chess")!.market, undefined);
});

test("happy-farm: 자동수확 집계 이벤트를 사용하고 레거시 auto 원시 이벤트를 제외", () => {
  const spec = contentSpecFor("happy-farm")!;
  const sql = buildContentSql(spec, "`p.d.events_*`", "20260101", "20260107");
  assert.match(sql, /event_name = 'auto_harvest_summary'/);
  assert.match(sql, /ep\.key = 'harvested_count'/);
  assert.match(sql, /ep\.key = 'total_gold'/);
  assert.match(sql, /ep\.key = 'harvest_source'[\s\S]*!= 'auto'/);
});
