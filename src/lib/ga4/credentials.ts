import { env } from "@/lib/env";

// BigQuery 수집과 GA4 Data API 실시간 조회가 같은 SA 키(seori-ga4-reader@seorilabs-ci)를 쓴다.
// 키 해석을 한 곳에 두어 두 클라이언트의 오류 문구와 파싱 규칙을 맞춘다.
export function ga4ServiceAccountCredentials(): Record<string, unknown> {
  const raw = env.ga4SaKeyJson();
  if (!raw) throw new Error("GA4_SA_KEY_JSON 미설정 — GA4 조회 불가");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("GA4_SA_KEY_JSON 파싱 실패(JSON 형식 아님)");
  }
}
