import assert from "node:assert/strict";
import test from "node:test";
import {
  financeReportDedupeKey,
  renderFinanceReport,
} from "@/lib/core/finance-report";
import type { CostWarning } from "@/lib/core/finance-costs";

const SUMMARY = [
  "이번 달(2026-08) 종량제 현황",
  "- GitHub Actions: 환산 2100분/3000분 (70%) · gross $12.6 · 실청구 $0",
  "- GCP: ₩11,200",
  "- LLM: $1.42 (gemini-3.1-flash-lite $1.42 (in 4.2M/out 310k))",
  "- Stability 크레딧: 725",
];

function warning(overrides: Partial<CostWarning> = {}): CostWarning {
  return {
    key: "gh-quota-70:2026-08",
    title: "GitHub Actions 포함분량 70% 소진",
    detail: "2026-08 환산 사용량이 포함분량의 70% 를 넘었다.",
    evidence: ["환산 사용량 2100분 / 포함 3000분"],
    ...overrides,
  };
}

test("경고가 없어도 이번 달 현황은 항상 싣는다", () => {
  const text = renderFinanceReport({ month: "2026-08", summaryLines: SUMMARY, warnings: [] });
  assert.equal(text.split("\n")[0], "💰 **서리 재무 리포트 · 2026-08**");
  for (const line of SUMMARY) assert.ok(text.includes(line), line);
  assert.ok(text.endsWith("경고 없음"));
});

test("경고는 건수와 함께 번호·근거까지 펼친다", () => {
  const text = renderFinanceReport({
    month: "2026-08",
    summaryLines: SUMMARY,
    warnings: [warning(), warning({ key: "gcp-budget:202608", title: "GCP 예산 초과", evidence: ["₩22,000 / 예산 ₩20,000"] })],
  });
  assert.ok(text.includes("⚠️ 경고 2건"));
  assert.ok(text.includes("**1. GitHub Actions 포함분량 70% 소진**"));
  assert.ok(text.includes("**2. GCP 예산 초과**"));
  assert.ok(text.includes("- 환산 사용량 2100분 / 포함 3000분"));
  assert.ok(text.includes("- ₩22,000 / 예산 ₩20,000"));
  assert.ok(!text.includes("경고 없음"));
});

test("리포트는 KST 날짜로 하루 1건이다", () => {
  // 00:00 UTC 발화는 KST 로 같은 날 09:00 이다. UTC 날짜로 잡으면 자정 근처 재시도가
  // 다른 키를 만들어 같은 날 리포트가 두 번 올라간다.
  assert.equal(financeReportDedupeKey(new Date("2026-08-27T00:00:00Z")), "finance:2026-08-27");
  assert.equal(financeReportDedupeKey(new Date("2026-08-26T15:30:00Z")), "finance:2026-08-27");
  assert.equal(financeReportDedupeKey(new Date("2026-08-26T14:30:00Z")), "finance:2026-08-26");
});
