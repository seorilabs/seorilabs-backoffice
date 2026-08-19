import assert from "node:assert/strict";
import test from "node:test";
import { releaseDeployRows } from "@/lib/discord/release-card";

const APP_ID = "cmqqr25r10009ry017kw6lvw1";
const TAG = "v1.1.6";

function labels(marketTargets: unknown): string[] {
  return releaseDeployRows(APP_ID, TAG, marketTargets).flatMap((row) =>
    row.components.map((c) => c.label),
  );
}

test("릴리즈 태그 카드에는 앱이 실제로 내보내는 마켓만 배포 버튼으로 나온다", () => {
  assert.deepEqual(labels(["ait"]), ["AppsInToss"]);
  assert.deepEqual(labels(["play"]), ["Google Play"]);
  assert.deepEqual(labels(["appstore"]), ["App Store"]);
});

test("배포 대상이 2개 이상일 때만 전체 배포를 함께 제공한다", () => {
  // 순서는 deployTargetsFor 가 정한다(AIT → Play → App Store → 전체).
  assert.deepEqual(labels(["play", "appstore", "ait"]), [
    "AppsInToss",
    "Google Play",
    "App Store",
    "전체(Deploy All)",
  ]);
  assert.deepEqual(labels(["play", "ait"]), ["AppsInToss", "Google Play", "전체(Deploy All)"]);
  // 단일 마켓 앱에 전체 배포를 노출하면 없는 워크플로를 dispatch 하게 된다.
  assert.ok(!labels(["ait"]).includes("전체(Deploy All)"));
});

test("배포 대상이 없거나 형식이 다르면 버튼을 만들지 않는다", () => {
  assert.deepEqual(releaseDeployRows(APP_ID, TAG, []), []);
  assert.deepEqual(releaseDeployRows(APP_ID, TAG, null), []);
  assert.deepEqual(releaseDeployRows(APP_ID, TAG, "play"), []);
  assert.deepEqual(releaseDeployRows(APP_ID, TAG, ["unknown"]), []);
});

test("배포 버튼 custom_id 는 대상·앱·태그를 담고 Discord 100자 제한 안에 있다", () => {
  const [row] = releaseDeployRows(APP_ID, TAG, ["play", "appstore", "ait"]);
  assert.equal(row.components[0].custom_id, `rdeploy:AIT:${APP_ID}:${TAG}`);
  for (const component of row.components) {
    assert.ok((component.custom_id ?? "").length <= 100, component.custom_id);
    // handler 는 ":" 분해로 target·appId·tag 를 읽는다. 조각 수가 어긋나면 파싱이 깨진다.
    assert.equal((component.custom_id ?? "").split(":").length, 4);
  }
  // Discord 는 한 행에 버튼 5개까지 허용한다.
  assert.ok(row.components.length <= 5);
});
