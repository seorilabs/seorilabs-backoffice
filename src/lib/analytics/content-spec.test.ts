import assert from "node:assert/strict";
import test from "node:test";
import { specEvents, assertIdent, type AppContentSpec } from "@/lib/analytics/content-spec";
import { contentSpecFor, contentSpecSlugs } from "@/lib/analytics/content-registry";

test("specEvents: 스펙 전반의 event 를 중복 없이 모은다", () => {
  const spec: AppContentSpec = {
    slug: "x",
    distributions: [
      { key: "a", label: "", event: "game_end", param: "outcome" },
      { key: "b", label: "", event: "game_end", param: "difficulty" },
    ],
    counters: [{ key: "c", label: "", event: "hint_used" }],
    measures: [{ key: "d", label: "", event: "game_end", param: "move_count", agg: "avg" }],
  };
  assert.deepEqual(specEvents(spec).sort(), ["game_end", "hint_used"]);
});

test("assertIdent: 규격 밖 식별자는 던진다", () => {
  assert.equal(assertIdent("game_end", "event"), "game_end");
  assert.throws(() => assertIdent("a b", "event"), /식별자 규격 위반/);
  assert.throws(() => assertIdent("x'; DROP", "event"), /식별자 규격 위반/);
});

test("registry: lucid-chess 스펙이 등록되어 있고 이벤트 이름이 규격을 지킨다", () => {
  const spec = contentSpecFor("lucid-chess");
  assert.ok(spec, "lucid-chess 스펙 등록됨");
  assert.ok(contentSpecSlugs().includes("lucid-chess"));
  // 게임 레포 컨텐츠 이벤트 카탈로그와 계약을 공유하는 핵심 이벤트가 포함되는지.
  const events = specEvents(spec!);
  for (const e of ["game_end", "game_abandon", "hint_used", "streak_claim"]) {
    assert.ok(events.includes(e), `${e} 포함`);
  }
  // 모든 이벤트/파라미터 키가 SQL 식별자 규격을 지켜 조립이 안전한지.
  for (const d of spec!.distributions) {
    assert.doesNotThrow(() => assertIdent(d.event, "event"));
    assert.doesNotThrow(() => assertIdent(d.param, "param"));
  }
  for (const m of spec!.measures) {
    assert.doesNotThrow(() => assertIdent(m.param, "param"));
  }
});

test("registry: 미등록 앱은 null(컨텐츠 지표 대상 아님)", () => {
  assert.equal(contentSpecFor("no-such-app"), null);
});
