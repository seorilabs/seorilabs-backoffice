import type { AppContentSpec } from "@/lib/analytics/content-spec";
import { lucidChessContentSpec } from "@/lib/analytics/specs/lucid-chess";
import { happyFarmContentSpec } from "@/lib/analytics/specs/happy-farm";
import { foamPartyContentSpec } from "@/lib/analytics/specs/foam-party";
import { crosswordPuzzleContentSpec } from "@/lib/analytics/specs/crossword-puzzle";

// 앱 slug → 컨텐츠 지표 스펙 레지스트리(모든 게임의 단일 진입점). 새 게임은
// specs/<slug>.ts 를 만들고 여기에 한 줄만 추가한다(충돌 표면 최소화). 스펙이 없는 앱은
// 컨텐츠 지표 수집 대상에서 자동 제외된다(공통 지표 AppMetricDaily 는 그대로 수집).
const REGISTRY: Record<string, AppContentSpec> = {
  [lucidChessContentSpec.slug]: lucidChessContentSpec,
  [happyFarmContentSpec.slug]: happyFarmContentSpec,
  [foamPartyContentSpec.slug]: foamPartyContentSpec,
  [crosswordPuzzleContentSpec.slug]: crosswordPuzzleContentSpec,
};

/** 앱 slug 의 컨텐츠 지표 스펙(없으면 null). */
export function contentSpecFor(slug: string): AppContentSpec | null {
  return REGISTRY[slug] ?? null;
}

/** 컨텐츠 지표 스펙이 등록된 모든 slug. */
export function contentSpecSlugs(): string[] {
  return Object.keys(REGISTRY);
}
