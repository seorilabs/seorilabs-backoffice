import { feedbackOverview, sourceHealth } from "@/lib/insights/queries";
import { getOrgReport } from "@/lib/core/org-report";
import { parseMetricDay } from "@/lib/analytics/metric-day";
import { findVisibleApp, type DiscordQueryResult } from "./queries";
import { env } from "@/lib/env";
const base = () => env.optional("AUTH_URL") || "https://backoffice.vzyx.xyz";
export async function insightCommandQuery(
  name: string,
  slug?: string,
  date?: string,
): Promise<DiscordQueryResult> {
  const app = slug ? await findVisibleApp(slug) : null;
  if (slug && !app) return { content: "앱을 찾을 수 없습니다." };
  if (name === "report") {
    if (date && !parseMetricDay(date))
      return { content: "기준일은 YYYY-MM-DD 형식의 실제 날짜여야 합니다." };
    const view = await getOrgReport(date || undefined);
    if (!view) return { content: "해당 날짜의 수집된 보고서가 없습니다." };
    const doc = view.doc;
    return {
      content: `**종합 지표 ${doc.refDate} · ${view.version ? `발행 v${view.version}` : "현재 원본 재계산"}**\n- 앱별 활성 합계 ${doc.summary.ga4.dau}명 · ${doc.summary.ga4.apps}개 앱 · 중복 사용자 포함\n- ${doc.summary.console.listings ? `광고 추정 ${Math.round(doc.summary.console.iaaKrw)}원 · 결제 거래액 ${Math.round(doc.summary.console.iapTrxKrw)}원` : "콘솔 수익 미수집"}\n- 콘솔 기준 ${doc.consoleMeta.refDate ?? "수집 없음"} · 지연 ${doc.consoleMeta.lagDays ?? "미상"}일\n${doc.narrative ?? "- 분석 자료 없음"}\n${base()}/?date=${doc.refDate}`,
    };
  }
  if (name === "health") {
    const health = await sourceHealth(app?.id);
    const rows = health.rows.filter(
      (row) => !["observed", "empty", "not_applicable"].includes(row.state),
    );
    return {
      content: `**수집 상태 · 지표 기준 ${health.day}**\n${
        rows.length
          ? rows
              .slice(0, 10)
              .map((row) => `- ${row.source} · ${row.target} · ${row.label}`)
              .join("\n")
          : "- 확인이 필요한 수집 항목 없음"
      }\n${base()}/settings/health`,
    };
  }
  const data = await feedbackOverview(app?.id);
  const names = new Map(data.apps.map((item) => [item.id, item.displayName]));
  if (name === "reviews")
    return {
      content: `**최근 리뷰 평점**\n${
        data.reviews
          .slice(0, 8)
          .map(
            (row) =>
              `- ${names.get(row.appId)} · ${row.store === "APP_STORE" ? "App Store" : "Google Play"} · ${row.rating}/5점`,
          )
          .join("\n") || "- 수집된 리뷰 없음"
      }\n원문·작성자 정보 제외 · 전체 스토어 평점과 다름\n${base()}/feedback`,
    };
  if (name === "keywords")
    return {
      content: `**검색 노출 관측**\n${
        data.market
          .filter((row) => row.kind === "keyword")
          .slice(0, 8)
          .map(
            (row) =>
              `- ${names.get(row.appId)} · ${row.country.toUpperCase()} ${row.target} · ${(row.value as { rank?: number | null }).rank ?? "200위 밖"}`,
          )
          .join("\n") || "- 수집된 검색 관측 없음"
      }\nApple 공개 API 순서 · 실제 기기 검색 순위와 다를 수 있음\n${base()}/feedback`,
    };
  return {
    content: `**최근 인사이트**\n${
      data.insights
        .slice(0, 5)
        .map(
          (row) => `- ${row.signal.title} · ${row.status}\n${base()}/feedback/insights/${row.id}`,
        )
        .join("\n") || "- 아직 인사이트 없음"
    }`,
  };
}
