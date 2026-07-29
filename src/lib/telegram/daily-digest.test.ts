import assert from "node:assert/strict";
import test from "node:test";
import {
  dailyRolloutBucket,
  deliverDailyDigest,
  filterDefaultBranchMerges,
  formatMergedPrLines,
  normalizeRolloutPercent,
  previousKstDayWindow,
  shouldUseDailyDigestGemini,
  type MergedPrDigestItem,
} from "@/lib/telegram/daily-digest";
import { env } from "@/lib/env";

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

test("Gemini rollout 환경변수 초기값은 10이고 0과 100을 그대로 읽는다", () => {
  const original = process.env.DAILY_DIGEST_GEMINI_ROLLOUT_PERCENT;
  try {
    delete process.env.DAILY_DIGEST_GEMINI_ROLLOUT_PERCENT;
    assert.equal(env.dailyDigestGeminiRolloutPercent(), 10);
    process.env.DAILY_DIGEST_GEMINI_ROLLOUT_PERCENT = "0";
    assert.equal(env.dailyDigestGeminiRolloutPercent(), 0);
    process.env.DAILY_DIGEST_GEMINI_ROLLOUT_PERCENT = "100";
    assert.equal(env.dailyDigestGeminiRolloutPercent(), 100);
  } finally {
    if (original === undefined) {
      delete process.env.DAILY_DIGEST_GEMINI_ROLLOUT_PERCENT;
    } else {
      process.env.DAILY_DIGEST_GEMINI_ROLLOUT_PERCENT = original;
    }
  }
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

test("Gemini 미호출일에도 확정적 병합 목록을 발송한다", async () => {
  let sent = "";
  const result = await deliverDailyDigest({
    lines: ["병합 변경사항", "• app #1 기능 추가"],
    send: async (text) => {
      sent = text;
      return { ok: true };
    },
  });

  assert.equal(result.geminiUsed, false);
  assert.match(sent, /app #1 기능 추가/);
});

test("Gemini 실패 시에도 확정적 병합 목록을 발송한다", async () => {
  let sent = "";
  const result = await deliverDailyDigest({
    lines: ["병합 변경사항", "• app #2 버그 수정"],
    generateGeminiSummary: async () => {
      throw new Error("quota exceeded");
    },
    send: async (text) => {
      sent = text;
      return { ok: true };
    },
  });

  assert.equal(result.geminiUsed, false);
  assert.match(sent, /app #2 버그 수정/);
  assert.doesNotMatch(sent, /AI 요약/);
});

test("Telegram 발송 실패를 throw해 Cron 성공 오인을 막는다", async () => {
  await assert.rejects(
    deliverDailyDigest({
      lines: ["병합 변경사항"],
      send: async () => ({ ok: false, error_code: 500 }),
    }),
    /Telegram 발송 실패/,
  );
});
