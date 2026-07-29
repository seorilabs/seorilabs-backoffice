import assert from "node:assert/strict";
import test from "node:test";
import {
  dailyRolloutBucket,
  filterDefaultBranchMerges,
  formatMergedPrLines,
  normalizeRolloutPercent,
  previousKstDayWindow,
  shouldUseDailyDigestGemini,
  type MergedPrDigestItem,
} from "@/lib/telegram/daily-digest";

function pr(
  repoFullName: string,
  number: number,
  baseRef: string | null,
  title = "변경",
): MergedPrDigestItem {
  return {
    repoFullName,
    number,
    baseRef,
    title,
    mergedAt: new Date("2026-07-28T01:00:00.000Z"),
  };
}

test("전일 KST 달력일을 UTC 경계로 변환한다", () => {
  const window = previousKstDayWindow(new Date("2026-07-29T00:00:00.000Z"));

  assert.equal(window.label, "2026-07-28");
  assert.equal(window.start.toISOString(), "2026-07-27T15:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-07-28T15:00:00.000Z");
});

test("Gemini rollout percent를 fail-closed 범위로 정규화한다", () => {
  assert.equal(normalizeRolloutPercent("10.9"), 10);
  assert.equal(normalizeRolloutPercent(-1), 0);
  assert.equal(normalizeRolloutPercent(101), 100);
  assert.equal(normalizeRolloutPercent("invalid"), 0);
});

test("Gemini rollout은 날짜별 고정 버킷 경계를 따른다", () => {
  const date = "2026-07-28";
  const bucket = dailyRolloutBucket(`daily-digest:${date}`);

  assert.equal(shouldUseDailyDigestGemini(date, bucket), false);
  assert.equal(shouldUseDailyDigestGemini(date, bucket + 1), true);
  assert.equal(shouldUseDailyDigestGemini(date, 0), false);
  assert.equal(shouldUseDailyDigestGemini(date, 100), true);
});

test("실제 default branch에 병합된 PR만 남기고 미확인 repo를 센다", () => {
  const result = filterDefaultBranchMerges(
    [
      pr("seorilabs/a", 1, "main"),
      pr("seorilabs/a", 2, "release"),
      pr("seorilabs/b", 3, "master"),
      pr("seorilabs/missing", 4, "main"),
    ],
    new Map([
      ["seorilabs/a", "main"],
      ["seorilabs/b", "master"],
    ]),
  );

  assert.deepEqual(
    result.mergedPrs.map((item) => item.number),
    [1, 3],
  );
  assert.equal(result.unresolvedCount, 1);
});

test("병합 PR 목록은 링크와 escape를 적용하고 최대 개수를 제한한다", () => {
  const lines = formatMergedPrLines(
    [
      pr("seorilabs/a", 1, "main", "<script> & 개선"),
      pr("seorilabs/b", 2, "main", "두 번째"),
    ],
    1,
  );

  assert.deepEqual(lines, [
    '• <a href="https://github.com/seorilabs/a/pull/1">a #1</a> &lt;script&gt; &amp; 개선',
    "• 그 외 1건",
  ]);
  assert.deepEqual(formatMergedPrLines([]), ["• 병합 없음"]);
});
