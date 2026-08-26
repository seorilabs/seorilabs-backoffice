import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isPlatformRegistryPush,
  resolvePlatformRegistryBindings,
} from "./registry-bindings";

describe("Platform registry app_id binding", () => {
  const registry = [
    { appId: "crossword-puzzle", firebaseProjectId: "crossword-puzzle-79ae0" },
    { appId: "ungeul", firebaseProjectId: "seorilabs-ungeul" },
  ];

  it("같은 slug는 app_id에 직접 결합한다", () => {
    const bindings = resolvePlatformRegistryBindings(
      [
        {
          id: "app-crossword",
          slug: "crossword-puzzle",
          firebaseProject: "crossword-puzzle-79ae0",
          platformAppId: null,
        },
      ],
      registry,
    );

    assert.deepEqual(bindings, [
      { appRecordId: "app-crossword", platformAppId: "crossword-puzzle" },
    ]);
  });

  it("saju-reader를 유일한 Firebase project로 ungeul에 결합한다", () => {
    const bindings = resolvePlatformRegistryBindings(
      [
        {
          id: "app-saju",
          slug: "saju-reader",
          firebaseProject: "seorilabs-ungeul",
          platformAppId: null,
        },
      ],
      registry,
    );

    assert.deepEqual(bindings, [
      { appRecordId: "app-saju", platformAppId: "ungeul" },
    ]);
  });

  it("원장에서 사라진 매핑은 null로 수렴시킨다", () => {
    const bindings = resolvePlatformRegistryBindings(
      [
        {
          id: "app-removed",
          slug: "removed-app",
          firebaseProject: "removed-project",
          platformAppId: "stale-app-id",
        },
      ],
      registry,
    );

    assert.deepEqual(bindings, [
      { appRecordId: "app-removed", platformAppId: null },
    ]);
  });

  it("Firebase project가 중복이면 추측하지 않고 실패한다", () => {
    assert.throws(
      () =>
        resolvePlatformRegistryBindings(
          [
            {
              id: "app-saju",
              slug: "saju-reader",
              firebaseProject: "shared-project",
              platformAppId: null,
            },
          ],
          [
            { appId: "first", firebaseProjectId: "shared-project" },
            { appId: "second", firebaseProjectId: "shared-project" },
          ],
        ),
      /Firebase project가 중복/,
    );
  });

  it("하나의 app_id가 여러 Backoffice 앱에 결합되면 실패한다", () => {
    assert.throws(
      () =>
        resolvePlatformRegistryBindings(
          [
            {
              id: "app-direct",
              slug: "ungeul",
              firebaseProject: null,
              platformAppId: null,
            },
            {
              id: "app-saju",
              slug: "saju-reader",
              firebaseProject: "seorilabs-ungeul",
              platformAppId: null,
            },
          ],
          registry,
        ),
      /여러 Backoffice 앱/,
    );
  });

  it("Platform main push만 즉시 동기화 대상으로 고른다", () => {
    assert.equal(
      isPlatformRegistryPush(
        "seorilabs/platform",
        "refs/heads/main",
        "seorilabs",
      ),
      true,
    );
    assert.equal(
      isPlatformRegistryPush(
        "seorilabs/platform",
        "refs/heads/feature/presence",
        "seorilabs",
      ),
      false,
    );
    assert.equal(
      isPlatformRegistryPush(
        "seorilabs/other",
        "refs/heads/main",
        "seorilabs",
      ),
      false,
    );
  });
});
