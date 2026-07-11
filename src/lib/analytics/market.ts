import { hasMarket, type AppContentSpec } from "@/lib/analytics/content-spec";
import { MARKET_ALL } from "@/lib/analytics/content-source";

// 마켓(플랫폼) 차원 공용 헬퍼. 이전엔 게임마다 제각각(foam=android/ios/web,
// crossword=apps-in-toss/google-play/app-store)으로 흩어져 있던 parseMarket/라벨/탭 로직을
// 스펙(spec.market) 구동 단일 소스로 통합한다. 대시보드/수집기/뷰가 공유한다.

/** 마켓 탭 한 항목. */
export interface MarketTab {
  key: string; // 'all' 또는 마켓 key
  label: string;
}

/** 통합('all') 탭 라벨. */
const ALL_LABEL = "통합";

/**
 * 스펙의 마켓 탭 목록(통합 + 선언된 마켓 순서대로). 마켓 미선언 스펙은 빈 배열
 * (탭을 노출하지 않는다).
 */
export function marketTabs(spec: AppContentSpec): MarketTab[] {
  if (!hasMarket(spec)) return [];
  return [{ key: MARKET_ALL, label: ALL_LABEL }, ...spec.market!.values.map((v) => ({ key: v.key, label: v.label }))];
}

/**
 * URL ?market= 값을 스펙 기준 유효 마켓 key 로 정규화한다. 마켓 미선언이거나 미지/공백은
 * 통합('all')으로 폴백한다. 다른 게임의 market 파라미터가 잘못 라우팅돼도 안전하게 'all'.
 */
export function parseMarket(spec: AppContentSpec, raw: string | undefined | null): string {
  if (!hasMarket(spec) || !raw) return MARKET_ALL;
  if (raw === MARKET_ALL) return MARKET_ALL;
  return spec.market!.values.some((v) => v.key === raw) ? raw : MARKET_ALL;
}

/** 마켓 key → 표시 라벨(통합 포함, 미지 key 는 원값). */
export function marketLabel(spec: AppContentSpec, key: string): string {
  if (key === MARKET_ALL) return ALL_LABEL;
  return spec.market?.values.find((v) => v.key === key)?.label ?? key;
}
