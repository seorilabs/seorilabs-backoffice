import assert from "node:assert/strict";
import test from "node:test";
import {
  deployCardComponents,
  deployCardCustomId,
  type AppStoreReviewCardState,
} from "@/lib/notifications/deploy-format";

const RELEASE_ID = "cmszaz3wd0asqs101uvv5ar6x";
const VERSION = "v1.1.6";

function labels(input: Parameters<typeof deployCardComponents>[0]): string[] {
  return deployCardComponents(input).flatMap((row) => row.components.map((c) => c.label));
}

function review(overrides: Partial<AppStoreReviewCardState> = {}): AppStoreReviewCardState {
  return {
    appStoreState: "PREPARE_FOR_SUBMISSION",
    versionEditable: true,
    submissionState: null,
    hasSubmissionItem: false,
    ...overrides,
  };
}

test("업로드가 성공하기 전에는 마켓 후속 작업 버튼을 노출하지 않는다", () => {
  for (const status of ["PENDING", "IN_PROGRESS", "FAILED", "ROLLED_BACK"] as const) {
    assert.deepEqual(labels({ releaseRecordId: RELEASE_ID, market: "PLAY", status, version: VERSION }), []);
    assert.deepEqual(
      labels({ releaseRecordId: RELEASE_ID, market: "APPSTORE", status, version: VERSION, review: review() }),
      [],
    );
  }
});

test("Play 업로드 성공 카드는 프로덕션 승격을 제공하고 승격을 이미 트리거했으면 감춘다", () => {
  assert.deepEqual(
    labels({ releaseRecordId: RELEASE_ID, market: "PLAY", status: "SUCCEEDED", version: VERSION }),
    ["프로덕션 승격"],
  );
  // 승격 실행 자체의 카드와, 이미 승격을 트리거한 업로드 카드 양쪽에서 버튼이 사라진다.
  assert.deepEqual(
    labels({
      releaseRecordId: RELEASE_ID,
      market: "PLAY",
      status: "SUCCEEDED",
      version: VERSION,
      promotionRequested: true,
    }),
    [],
  );
});

test("AIT·Web 배포에는 카드 액션이 없다", () => {
  for (const market of ["AIT", "WEB"] as const) {
    assert.deepEqual(labels({ releaseRecordId: RELEASE_ID, market, status: "SUCCEEDED", version: VERSION }), []);
  }
});

test("App Store 버튼은 심사 단계에 따라 실행 가능한 것만 남는다", () => {
  const base = { releaseRecordId: RELEASE_ID, market: "APPSTORE" as const, status: "SUCCEEDED" as const, version: VERSION };

  // 아직 심사를 만들지 않음 → 생성만.
  assert.deepEqual(labels({ ...base, review: review() }), ["심사 생성", "상태 새로고침"]);
  assert.deepEqual(
    labels({ ...base, review: review({ appStoreState: null, versionEditable: false }) }),
    ["심사 생성", "상태 새로고침"],
  );

  // 생성됨·미제출 → 제출과 삭제.
  assert.deepEqual(
    labels({ ...base, review: review({ submissionState: "READY_FOR_REVIEW", hasSubmissionItem: true }) }),
    ["심사 제출", "심사 삭제", "상태 새로고침"],
  );

  // 제출됨 → 취소만. 이 단계에서 삭제나 재제출은 ASC 가 거부한다.
  for (const submissionState of ["WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES"]) {
    assert.deepEqual(
      labels({ ...base, review: review({ submissionState, hasSubmissionItem: true }) }),
      ["제출 취소", "상태 새로고침"],
      submissionState,
    );
  }

  // ASC 가 처리 중인 단계에서는 개입할 수 없다.
  for (const submissionState of ["CANCELING", "COMPLETING"]) {
    assert.deepEqual(
      labels({ ...base, review: review({ submissionState, hasSubmissionItem: true }) }),
      ["상태 새로고침"],
      submissionState,
    );
  }
});

test("다른 버전이 제출을 점유했거나 편집 불가 상태면 심사 생성을 노출하지 않는다", () => {
  const base = { releaseRecordId: RELEASE_ID, market: "APPSTORE" as const, status: "SUCCEEDED" as const, version: VERSION };
  assert.deepEqual(
    labels({ ...base, review: review({ submissionState: "IN_REVIEW", hasSubmissionItem: false }) }),
    ["상태 새로고침"],
  );
  assert.deepEqual(
    labels({
      ...base,
      review: review({ appStoreState: "READY_FOR_SALE", versionEditable: false }),
    }),
    ["상태 새로고침"],
  );
});

test("심사 상태를 읽지 못하면 임의 액션 대신 새로고침만 남긴다", () => {
  assert.deepEqual(
    labels({ releaseRecordId: RELEASE_ID, market: "APPSTORE", status: "SUCCEEDED", version: VERSION, review: null }),
    ["상태 새로고침"],
  );
});

test("카드 버튼 custom_id 는 Discord 100자 제한 안에서 액션과 배포 기록을 함께 담는다", () => {
  const id = deployCardCustomId("appstore_review_create", RELEASE_ID);
  assert.equal(id, `deploycard:appstore_review_create:${RELEASE_ID}`);
  assert.ok(id.length <= 100);
  for (const row of deployCardComponents({
    releaseRecordId: RELEASE_ID,
    market: "APPSTORE",
    status: "SUCCEEDED",
    version: VERSION,
    review: review({ submissionState: "READY_FOR_REVIEW", hasSubmissionItem: true }),
  })) {
    for (const component of row.components) {
      assert.ok((component.custom_id ?? "").length <= 100);
      assert.ok(component.label.length <= 80);
    }
  }
});

test("태그를 못 찾은 배포에는 후속 작업 버튼을 달지 않는다", () => {
  // mirror 는 태그를 못 찾으면 version 을 "untagged" 로 남긴다. 이 카드의 버튼은
  // handler 의 태그 검사에 걸려 항상 거부되므로 애초에 노출하지 않는다.
  for (const version of ["untagged", "", "1.1.6", "v1.1"]) {
    assert.deepEqual(
      labels({ releaseRecordId: RELEASE_ID, market: "PLAY", status: "SUCCEEDED", version }),
      [],
      version,
    );
    assert.deepEqual(
      labels({
        releaseRecordId: RELEASE_ID,
        market: "APPSTORE",
        status: "SUCCEEDED",
        version,
        review: review(),
      }),
      [],
      version,
    );
  }
});
