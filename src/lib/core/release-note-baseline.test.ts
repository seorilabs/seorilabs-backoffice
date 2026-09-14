import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPreviousReleaseVersions } from "./release-note-baseline";

test("마켓별 마지막 성공 배포를 서로 다른 출시노트 기준으로 고른다", () => {
  const selected = selectPreviousReleaseVersions(
    [
      { market: "PLAY", version: "v1.0.14", status: "SUCCEEDED", deployedAt: new Date("2026-09-14T12:00:00Z") },
      { market: "PLAY", version: "v1.0.15", status: "FAILED", deployedAt: null },
      { market: "APPSTORE", version: "v1.0.10", status: "SUCCEEDED", deployedAt: new Date("2026-09-10T12:00:00Z") },
      { market: "AIT", version: "v1.0.13", status: "FAILED", deployedAt: null },
      { market: "AIT", version: "v1.0.9", status: "SUCCEEDED", deployedAt: new Date("2026-09-09T12:00:00Z") },
      { market: "AIT", version: "untagged", status: "SUCCEEDED", deployedAt: new Date("2026-09-15T12:00:00Z") },
    ],
    "v1.0.15",
  );

  assert.deepEqual(selected, {
    PLAY: "v1.0.14",
    APPSTORE: "v1.0.10",
    AIT: "v1.0.9",
  });
});

test("현재 버전이 이미 성공했어도 직전 성공 버전을 유지한다", () => {
  const selected = selectPreviousReleaseVersions(
    [
      { market: "AIT", version: "v1.0.15", status: "SUCCEEDED", deployedAt: new Date("2026-09-15T12:00:00Z") },
      { market: "AIT", version: "v1.0.14", status: "SUCCEEDED", deployedAt: new Date("2026-09-14T12:00:00Z") },
    ],
    "v1.0.15",
  );

  assert.equal(selected.AIT, "v1.0.14");
});
