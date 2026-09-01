import assert from "node:assert/strict";
import test from "node:test";
import {
  DISABLED_APP_STATUS,
  WRITABLE_APP_STATUSES,
  approvalIssueWhere,
  isDisabledAppStatus,
  isWritableAppStatus,
  visibleAppWhere,
} from "@/lib/domain/app-visibility";

test("DEPRECATED 는 DB 전용 비활성 플래그이며 앱에서 쓰기 가능한 상태가 아니다", () => {
  assert.equal(DISABLED_APP_STATUS, "DEPRECATED");
  assert.deepEqual(WRITABLE_APP_STATUSES, ["ACTIVE", "PAUSED"]);
  assert.equal(isDisabledAppStatus("DEPRECATED"), true);
  assert.equal(isWritableAppStatus("DEPRECATED"), false);
});

test("visibleAppWhere 는 비활성 앱을 제외한다", () => {
  assert.deepEqual(visibleAppWhere, { status: { not: "DEPRECATED" } });
});

test("approvalIssueWhere 는 visible 앱과 appId 없는 조직 인프라 이슈를 함께 포함한다", () => {
  assert.deepEqual(approvalIssueWhere, {
    OR: [
      { app: { is: { status: { not: "DEPRECATED" } } } },
      { appId: null },
    ],
  });
});
