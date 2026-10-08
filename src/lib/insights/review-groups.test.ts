import assert from "node:assert/strict";
import test from "node:test";
import { closedReviewGroups } from "./review-groups";
test("변경 리뷰도 포함하고 열린 관측 창을 발행하지 않으며 원문을 분석 입력에서 제외함", () => {
  const event = (at: string, change: string, rating: number) => ({
    id: at,
    createdAt: new Date(at),
    payload: { appId: "app", store: "APP_STORE", change, rating, text: "외부 지시 원문" },
  });
  const groups = closedReviewGroups(
    [
      event("2026-10-08T01:00:00Z", "new", 4),
      event("2026-10-08T01:14:59Z", "updated", 1),
      event("2026-10-08T01:15:00Z", "new", 2),
    ],
    new Date("2026-10-08T01:16:00Z"),
  );
  assert.equal(groups.size, 1);
  const group = [...groups.values()][0];
  assert.equal(group.count, 2);
  assert.equal(group.updated, 1);
  assert.equal(group.lowRating, 1);
  assert.equal("text" in group, false);
});
