import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMovement } from "@/lib/core/metric-highlights";
import {
  ORG_REPORT_SCHEMA_VERSION,
  parseOrgReportDocument,
  serializeMovement,
  type OrgReportDocument,
} from "@/lib/core/org-report-schema";

function sampleDocument(): OrgReportDocument {
  return {
    version: ORG_REPORT_SCHEMA_VERSION,
    refDate: "2026-08-31",
    generatedAt: "2026-09-01T02:00:00.000Z",
    origin: "published",
    summary: {
      ga4: { dau: 120, dauPrev: 100, newUsers: 12, engagedUsers: 80, adCompletions: 40, apps: 5 },
      console: {
        iaaKrw: 4_500,
        iaaPrevKrw: 4_000,
        iapTrxKrw: 0,
        iapSettlementKrw: 0,
        payingUsers: 0,
        listings: 6,
      },
    },
    platform: {
      android: { dau: 70, dauPrev: 60 },
      ios: { dau: 30, dauPrev: 25 },
      web: { dau: 20, dauPrev: 15 },
    },
    segments: {
      game: { apps: 4, dau: 100, dauPrev: 85, iaaKrw: 4_500, iapTrxKrw: 0 },
      app: { apps: 1, dau: 20, dauPrev: 15, iaaKrw: 0, iapTrxKrw: 0 },
    },
    apps: [
      {
        slug: "happy-farm",
        displayName: "행복 농장 타이쿤",
        type: "GAME",
        ga4: {
          date: "2026-08-31",
          dau: 60,
          dauPrev: 50,
          dau7dMedian: 48,
          newUsers: 6,
          d1Pct: 22,
          engagedUsers: 40,
          adCompletions: 30,
          dauAndroid: 40,
          dauIos: 10,
          dauWeb: 10,
        },
        listings: [
          {
            miniAppId: 31877,
            label: null,
            date: "2026-08-30",
            lagDays: 1,
            dau: 30,
            newUsers: 3,
            iaaKrw: 2_000,
            iapTrxKrw: 0,
            payingUsers: 0,
          },
        ],
      },
    ],
    movements: [],
    referrers: [{ dimension: "전체탭", rate: 0.8 }],
    narrative: "농장 상승이 두 소스에서 함께 보인다.",
    costs: {
      month: "2026-09",
      summaryLines: ["이번 달(2026-09) 종량제 현황"],
      warnings: [],
      figures: {
        github: { quotaMinutes: 120, includedMinutes: 3_000, grossUsd: 1.2, netUsd: 0 },
        gcp: { total: 15_000, currency: "KRW" },
        llm: { totalUsd: 3.4 },
        stability: null,
      },
    },
    consoleMeta: { refDate: "2026-08-30", lagDays: 1, listings: 6, onRefDate: 5, missing: [] },
  };
}

test("문서는 JSON 왕복 후에도 그대로 복원된다", () => {
  const doc = sampleDocument();
  const restored = parseOrgReportDocument(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(restored, doc);
});

test("알 수 없는 필드·버전 불일치는 재계산 강등(null)이다", () => {
  const doc = sampleDocument();
  assert.equal(parseOrgReportDocument({ ...doc, unknownField: 1 }), null);
  assert.equal(parseOrgReportDocument({ ...doc, version: ORG_REPORT_SCHEMA_VERSION + 1 }), null);
  assert.equal(parseOrgReportDocument(null), null);
  assert.equal(parseOrgReportDocument("문서 아님"), null);
});

test("Movement 직렬화는 spec 함수를 배제하고 metricKey 만 남긴다", () => {
  const movement = evaluateMovement({
    label: "행복 농장 타이쿤",
    metricKey: "ga4_dau",
    latest: 420,
    baseline: 250,
    date: "2026-08-31",
  });
  const snapshot = serializeMovement(movement);
  assert.equal(snapshot.metricKey, "ga4_dau");
  assert.equal(snapshot.verdict, "highlight");
  assert.ok(!("spec" in snapshot));
  // JSON 왕복이 값을 잃지 않는다(함수가 없으므로).
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test("sample 이 없는 Movement 는 sample 키 자체를 만들지 않는다", () => {
  const movement = evaluateMovement({
    label: "체스",
    metricKey: "ga4_dau",
    latest: 10,
    baseline: 8,
    date: "2026-08-31",
  });
  assert.ok(!("sample" in serializeMovement(movement)));
});

test("지표와 재무 본문은 수집 건수와 서로 다른 목적의 지표를 섞지 않는다",async()=>{
 const {renderDailyEdition,renderFinancialEdition}=await import("@/lib/report/daily-presentation");
 const doc=sampleDocument();doc.apps[0].listings[0].avgSessionSec=42;
 const metrics=renderDailyEdition(doc,1,null);assert.match(metrics,/평균 이용 시간 42초/);assert.match(metrics,/기준 2026-08-30/);assert.doesNotMatch(metrics,/수집 범위.*개|비용|광고 추정 수익|거래액/);
 const finance=renderFinancialEdition(doc,null);assert.doesNotMatch(finance,/활성 사용자|잔존율|이용 시간|수집 성공/);assert.match(finance,/거래액/);
 doc.summary.console.listings=0;doc.consoleMeta.refDate=null;assert.match(renderFinancialEdition(doc,null),/광고 추정 수익 미수집/);
});
