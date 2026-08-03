import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  findTagRefId,
  isXcodeCloudRepo,
  selectWorkflowForRepository,
  waitForTagRefId,
  type WorkflowCandidate,
} from "./dispatch";

const KEY = "XCODE_CLOUD_APP_STORE_REPOS";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

test("allowlist(CSV) 에 있는 repo 는 Xcode Cloud 대상", () => {
  process.env[KEY] = "seorilabs/happy-farm, seorilabs/foo";
  assert.equal(isXcodeCloudRepo("seorilabs/happy-farm"), true);
  assert.equal(isXcodeCloudRepo("seorilabs/foo"), true);
});

test("allowlist 에 없는 repo 는 대상 아님", () => {
  process.env[KEY] = "seorilabs/happy-farm";
  assert.equal(isXcodeCloudRepo("seorilabs/other"), false);
});

test("미설정/빈 allowlist 는 전부 대상 아님", () => {
  delete process.env[KEY];
  assert.equal(isXcodeCloudRepo("seorilabs/happy-farm"), false);
  process.env[KEY] = "";
  assert.equal(isXcodeCloudRepo("seorilabs/happy-farm"), false);
});

const cycleRelease: WorkflowCandidate = {
  id: "cycle-release",
  name: "Cycle Pair Release",
  repoFullName: "seorilabs/cycle-pair",
  isEnabled: true,
  actions: [
    {
      actionType: "ARCHIVE",
      platform: "IOS",
      buildDistributionAudience: "APP_STORE_ELIGIBLE",
    },
  ],
};

test("같은 제품의 교차 앱 workflow를 제외하고 요청 repo workflow만 선택", () => {
  const lizardWorkflow: WorkflowCandidate = {
    ...cycleRelease,
    id: "lizard-release",
    name: "Lizard Tycoon TestFlight",
    repoFullName: "seorilabs/lizard-tycoon",
  };
  assert.equal(
    selectWorkflowForRepository(
      [lizardWorkflow, cycleRelease],
      "seorilabs/cycle-pair",
    ),
    "cycle-release",
  );
});

test("repo가 다르거나 App Store Archive가 아니면 임의 실행하지 않음", () => {
  assert.throws(
    () =>
      selectWorkflowForRepository(
        [
          { ...cycleRelease, repoFullName: "seorilabs/lizard-tycoon" },
          {
            ...cycleRelease,
            id: "development-archive",
            actions: [
              {
                actionType: "ARCHIVE",
                platform: "IOS",
                buildDistributionAudience: null,
              },
            ],
          },
        ],
        "seorilabs/cycle-pair",
      ),
    /workflow 선택 실패/,
  );
});

test("동일 repo의 배포 workflow가 둘이면 모호성을 실패 처리", () => {
  assert.throws(
    () =>
      selectWorkflowForRepository(
        [cycleRelease, { ...cycleRelease, id: "cycle-release-2" }],
        "seorilabs/cycle-pair",
      ),
    /일치=2/,
  );
});

test("정확한 TAG 이름의 ref id를 찾음", () => {
  assert.equal(
    findTagRefId(
      [
        { id: "branch", attributes: { kind: "BRANCH", name: "v0.0.2" } },
        { id: "other-tag", attributes: { kind: "TAG", name: "v0.0.1" } },
        { id: "target-tag", attributes: { kind: "TAG", name: "v0.0.2" } },
      ],
      "v0.0.2",
    ),
    "target-tag",
  );
});

test("Xcode Cloud 태그 ref 동기화 지연을 재시도", async () => {
  let loads = 0;
  const refId = await waitForTagRefId(
    "v0.0.2",
    async () => {
      loads += 1;
      return loads < 3
        ? []
        : [{ id: "synced-tag", attributes: { kind: "TAG", name: "v0.0.2" } }];
    },
    { delaysMs: [0, 0, 0] },
  );

  assert.equal(refId, "synced-tag");
  assert.equal(loads, 3);
});

test("재시도 후에도 태그 ref가 없으면 운영 확인 항목을 안내", async () => {
  await assert.rejects(
    () => waitForTagRefId("v0.0.2", async () => [], { delaysMs: [0, 0] }),
    /Manual Start - Tag\(v\*\).*SCM 연결 상태/,
  );
});
