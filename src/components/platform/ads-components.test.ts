import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PlatformAdsBlockReasons,
  PlatformAdsLookupFeedback,
  PlatformAdsPolicyBadge,
} from "./PlatformAdsStates";

describe("광고 운영툴 상태 컴포넌트", () => {
  it("idle, loading, not-found, read-failure를 서로 다르게 그린다", () => {
    assert.equal(
      renderToStaticMarkup(
        createElement(PlatformAdsLookupFeedback, { state: "idle" }),
      ),
      "",
    );
    assert.match(
      renderToStaticMarkup(
        createElement(PlatformAdsLookupFeedback, { state: "loading" }),
      ),
      /조회 중/,
    );
    assert.match(
      renderToStaticMarkup(
        createElement(PlatformAdsLookupFeedback, { state: "not_found" }),
      ),
      /찾지 못했습니다/,
    );
    assert.match(
      renderToStaticMarkup(
        createElement(PlatformAdsLookupFeedback, {
          state: "read_failure",
          error: "service unavailable",
        }),
      ),
      /확인 실패.*service unavailable/,
    );
  });

  it("광고 허용, 차단, 광고 미사용 앱을 구분한다", () => {
    const badge = (appUsesAds: boolean, adsEnabled: boolean) =>
      renderToStaticMarkup(
        createElement(PlatformAdsPolicyBadge, {
          policy: {
            appUsesAds,
            adsEnabled,
            disabledBy: [],
            checkedAt: "2026-08-09T00:00:00Z",
          },
        }),
      );
    assert.match(badge(true, true), /광고 허용/);
    assert.match(badge(true, false), /광고 차단/);
    assert.match(badge(false, false), /광고 기능을 사용하지 않는 앱/);
  });

  it("운영자 차단, ad_free, 두 원인을 각각 표시한다", () => {
    const reasons = (disabledBy: Array<"operator" | "ad_free">) =>
      renderToStaticMarkup(
        createElement(PlatformAdsBlockReasons, { reasons: disabledBy }),
      );
    assert.equal(reasons(["operator"]), "운영자 차단");
    assert.equal(reasons(["ad_free"]), "ad_free");
    assert.equal(reasons(["operator", "ad_free"]), "운영자 차단 + ad_free");
  });
});
