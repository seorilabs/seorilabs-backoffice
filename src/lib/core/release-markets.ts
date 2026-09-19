// 출시노트 마켓 표기/필터 공통 정의.
// ReleaseNote.market 은 expand 단계라 nullable — legacy NULL row 를 "공통"이라는 별도 키로
// 다뤄야 필터에서도 도달 가능하다. UI(카드/목록/팝업)와 쿼리가 같은 정의를 쓰도록 한곳에 둔다.

import type { ReleaseMarket } from "@prisma/client";

/** market = NULL 인 legacy 공통 row 를 가리키는 필터 키. Prisma enum 과 충돌하지 않는 값. */
export const LEGACY_MARKET_KEY = "LEGACY";

export type ReleaseMarketKey = ReleaseMarket | typeof LEGACY_MARKET_KEY;

/** 목록/버튼을 항상 같은 순서로 보여 준다. */
export const RELEASE_MARKET_KEY_ORDER = [
  "PLAY",
  "APPSTORE",
  "AIT",
  "WEB",
  LEGACY_MARKET_KEY,
] as const satisfies readonly ReleaseMarketKey[];

export const RELEASE_MARKET_LABEL: Record<ReleaseMarketKey, string> = {
  PLAY: "Google Play",
  APPSTORE: "App Store",
  AIT: "AppsInToss",
  WEB: "Web",
  LEGACY: "공통(legacy)",
};

export const RELEASE_MARKET_BADGE: Record<ReleaseMarketKey, string> = {
  PLAY: "bg-emerald-100 text-emerald-800",
  APPSTORE: "bg-sky-100 text-sky-800",
  AIT: "bg-amber-100 text-amber-800",
  WEB: "bg-violet-100 text-violet-800",
  LEGACY: "bg-neutral-200 text-neutral-700",
};

export function releaseMarketKey(market: ReleaseMarket | null): ReleaseMarketKey {
  return market ?? LEGACY_MARKET_KEY;
}

/** 쿼리 파라미터 → 마켓 키. 빈 값/모르는 값은 undefined(= 전체). */
export function parseReleaseMarketKey(raw: string | undefined): ReleaseMarketKey | undefined {
  if (!raw) return undefined;
  return (RELEASE_MARKET_KEY_ORDER as readonly string[]).includes(raw)
    ? (raw as ReleaseMarketKey)
    : undefined;
}

/** 마켓 키 → Prisma where 조각. 전체이면 조건을 붙이지 않는다. */
export function releaseMarketWhere(
  key: ReleaseMarketKey | undefined,
): { market?: ReleaseMarket | null } {
  if (!key) return {};
  return { market: key === LEGACY_MARKET_KEY ? null : key };
}
