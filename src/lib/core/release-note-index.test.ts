import { test } from "node:test";
import assert from "node:assert/strict";
import { groupNotesByVersion, latestVersionPerApp } from "./release-note-index";
import { LEGACY_MARKET_KEY, parseReleaseMarketKey, releaseMarketWhere } from "./release-markets";

const at = (iso: string) => new Date(iso);

test("앱별 최신 태그만 남긴다 (최신순 입력 가정)", () => {
  const latest = latestVersionPerApp([
    { appId: "a", version: "v1.3.0" },
    { appId: "b", version: "v2.0.1" },
    { appId: "a", version: "v1.2.0" },
    { appId: "b", version: "v2.0.0" },
  ]);
  assert.deepEqual(latest, [
    { appId: "a", version: "v1.3.0" },
    { appId: "b", version: "v2.0.1" },
  ]);
});

test("마켓 row 를 태그로 묶고 마켓 순서를 고정한다", () => {
  const base = { previousVersion: "v1.1.0", compareUrl: null };
  const groups = groupNotesByVersion([
    { id: "1", version: "v1.2.0", market: "AIT" as const, createdAt: at("2026-09-02T00:00:00Z"), ...base },
    { id: "2", version: "v1.2.0", market: "PLAY" as const, createdAt: at("2026-09-02T01:00:00Z"), ...base },
    { id: "3", version: "v1.2.0", market: null, createdAt: at("2026-09-02T00:30:00Z"), ...base },
    { id: "4", version: "v1.1.0", market: "APPSTORE" as const, createdAt: at("2026-08-20T00:00:00Z"), ...base, previousVersion: null },
  ]);

  assert.deepEqual(
    groups.map((g) => g.version),
    ["v1.2.0", "v1.1.0"],
  );
  // PLAY → AIT → 공통(legacy) 순서. 입력 순서와 무관하다.
  assert.deepEqual(groups[0].notes.map((n) => n.id), ["2", "1", "3"]);
  // 태그 대표 시각은 그 태그 마켓 row 중 가장 늦은 것.
  assert.equal(groups[0].createdAt.toISOString(), "2026-09-02T01:00:00.000Z");
  assert.equal(groups[0].previousVersion, "v1.1.0");
});

test("빈 목록은 빈 그룹", () => {
  assert.deepEqual(groupNotesByVersion([]), []);
});

test("마켓 필터 파라미터가 Prisma where 로 그대로 내려간다", () => {
  assert.deepEqual(releaseMarketWhere(parseReleaseMarketKey("PLAY")), { market: "PLAY" });
  assert.deepEqual(releaseMarketWhere(parseReleaseMarketKey(LEGACY_MARKET_KEY)), { market: null });
  // 전체 / 알 수 없는 값은 조건을 붙이지 않는다 — 조용히 빈 결과가 되지 않게 한다.
  assert.deepEqual(releaseMarketWhere(parseReleaseMarketKey(undefined)), {});
  assert.deepEqual(releaseMarketWhere(parseReleaseMarketKey("NOPE")), {});
});
