import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAppWorkspaceTabs, type AppWorkspaceSource } from "./workspace";

const base: AppWorkspaceSource = {
  id: "app_1",
  slug: "no-such-app",
  firebaseProject: null,
  ga4Dataset: null,
  aitWorkspaceId: null,
  aitMiniAppId: null,
  opsManifest: null,
  opsManifestError: null,
};

test("앱 워크스페이스는 고정된 9개 관리 영역을 제공한다", () => {
  const tabs = buildAppWorkspaceTabs(base);
  assert.deepEqual(
    tabs.map((tab) => tab.key),
    [
      "overview",
      "metrics",
      "operations",
      "commerce",
      "ads",
      "content",
      "flags",
      "development",
      "releases",
    ],
  );
  assert.equal(tabs[0].href, "/apps/app_1");
});

test("manifest 도구와 분석 소스에 따라 준비 상태를 계산한다", () => {
  const tabs = buildAppWorkspaceTabs({
    ...base,
    firebaseProject: "sample",
    ga4Dataset: "analytics_1",
    opsManifest: {
      version: 1,
      tools: [
        {
          id: "iap",
          section: "commerce",
          title: "IAP 관리",
          description: "테스트 계정 지급과 회수를 관리합니다.",
          operations: [],
        },
      ],
    },
  });
  const byKey = Object.fromEntries(tabs.map((tab) => [tab.key, tab.readiness]));
  assert.equal(byKey.metrics, "partial");
  assert.equal(byKey.commerce, "ready");
  assert.equal(byKey.flags, "missing");
});

test("manifest 오류는 해당 도구 영역을 partial로 표시한다", () => {
  const tabs = buildAppWorkspaceTabs({
    ...base,
    opsManifestError: "tools.0: invalid",
  });
  assert.equal(tabs.find((tab) => tab.key === "operations")?.readiness, "partial");
});
