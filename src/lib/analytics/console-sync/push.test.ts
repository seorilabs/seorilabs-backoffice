import test from "node:test";
import assert from "node:assert/strict";
import { AIT_LISTINGS } from "../ait-apps";
import { consolePushAppId } from "./push";

test("slug를 생략한 보조 리스팅도 저장 경로와 같은 코드표로 조회한다", () => {
  const listing = AIT_LISTINGS.find((listing) => listing.appSlug === "crossword-puzzle")!;
  const registry = [{ id: "app-id", slug: listing.appSlug, aitMiniAppId: 999 }];
  assert.equal(consolePushAppId({ miniAppId: listing.miniAppId }, registry), "app-id");
  assert.equal(consolePushAppId({ slug: listing.appSlug, miniAppId: listing.miniAppId }, registry), "app-id");
  assert.equal(consolePushAppId({ slug: "wrong", miniAppId: 999 }, registry), undefined);
});
