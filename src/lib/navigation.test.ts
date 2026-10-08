import assert from "node:assert/strict";
import test from "node:test";
import { NAVIGATION_SECTIONS, isNavigationLinkActive } from "./navigation";
const links = NAVIGATION_SECTIONS.flatMap((section) => section.links);
test("주 메뉴는 8개이며 하위 화면에서 하나만 활성화됨", () => {
 assert.equal(links.length, 8);
 for (const path of ["/", "/apps/a/operations/ads", "/analytics", "/work/issues", "/releases", "/feedback/insights/a", "/platform/iap", "/settings/health"]) assert.equal(links.filter((link) => isNavigationLinkActive(path, link)).length, 1, path);
 assert.equal(links.filter((link) => isNavigationLinkActive("/work-archive", link)).length, 0);
});
