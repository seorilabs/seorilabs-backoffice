import { env } from "@/lib/env";

// Org 종합 보고서 페이지 경로·링크 조립. Discord 리포트 푸터와 페이지 라우트가
// 같은 정본을 쓴다. prisma 를 끌지 않는 경량 모듈로 분리해 렌더 전용 테스트
// 그래프를 무겁게 만들지 않는다.

export const ORG_REPORT_PATH = "/report";

/** 백오피스 보고서 절대 URL. AUTH_URL 미설정이면 null(푸터 생략). */
export function orgReportUrl(refDate?: string): string | null {
  const base = env.optional("AUTH_URL").trim();
  if (!base) return null;
  return `${base}${ORG_REPORT_PATH}${refDate ? `?date=${refDate}` : ""}`;
}
