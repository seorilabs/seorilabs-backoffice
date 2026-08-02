import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NAVIGATION_SECTIONS,
  isNavigationLinkActive,
  type NavigationLink,
} from "./navigation";

function link(href: string): NavigationLink {
  const found = NAVIGATION_SECTIONS.flatMap((section) => section.links).find(
    (candidate) => candidate.href === href,
  );
  assert.ok(found, `내비게이션 링크가 없습니다: ${href}`);
  return found;
}

describe("좌측 내비게이션 구조", () => {
  it("플랫폼과 앱 두 섹션을 고정된 순서로 제공한다", () => {
    assert.deepEqual(
      NAVIGATION_SECTIONS.map((section) => [section.key, section.label]),
      [
        ["platform", "플랫폼"],
        ["apps", "앱"],
      ],
    );
  });

  it("플랫폼 링크와 기존 앱 링크를 모두 보존한다", () => {
    assert.deepEqual(
      NAVIGATION_SECTIONS[0]?.links.map(({ href, label }) => [href, label]),
      [
        ["/platform", "개요"],
        ["/platform/auth", "인증"],
        ["/platform/iap", "IAP"],
      ],
    );
    assert.deepEqual(
      NAVIGATION_SECTIONS[1]?.links.map(({ href }) => href),
      [
        "/",
        "/board",
        "/analytics",
        "/issues",
        "/approvals",
        "/releases",
        "/release-notes",
        "/plan",
        "/settings",
      ],
    );
  });
});

describe("활성 링크 판정", () => {
  it("exact 링크는 정확히 같은 경로에서만 활성화한다", () => {
    assert.equal(isNavigationLinkActive("/platform", link("/platform")), true);
    assert.equal(isNavigationLinkActive("/platform/iap", link("/platform")), false);
    assert.equal(isNavigationLinkActive("/", link("/")), true);
    assert.equal(isNavigationLinkActive("/apps/app-1", link("/")), false);
  });

  it("nested 링크는 자신과 하위 경로에서 활성화한다", () => {
    assert.equal(isNavigationLinkActive("/platform/iap", link("/platform/iap")), true);
    assert.equal(
      isNavigationLinkActive("/platform/iap/orders", link("/platform/iap")),
      true,
    );
    assert.equal(isNavigationLinkActive("/issues/123", link("/issues")), true);
  });

  it("비슷한 접두사지만 다른 세그먼트인 경로는 활성화하지 않는다", () => {
    assert.equal(
      isNavigationLinkActive("/platform/iap-old", link("/platform/iap")),
      false,
    );
    assert.equal(isNavigationLinkActive("/issues-archive", link("/issues")), false);
  });
});
