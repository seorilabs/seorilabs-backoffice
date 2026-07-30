import type { AppContentSpec } from "@/lib/analytics/content-spec";
import { contentSpecFor } from "@/lib/analytics/content-registry";
import { contentSpecFromManifest } from "@/lib/app-ops/manifest";

/**
 * 게임 저장소 manifest의 컨텐츠 스펙을 우선하고, 기존 중앙 레지스트리를 마이그레이션
 * 기간의 fallback으로 사용한다. 게임별 세션은 백오피스 코드를 수정하지 않고
 * .seorilabs/backoffice.json만 변경할 수 있다.
 */
export function resolveAppContentSpec(
  slug: string,
  manifestValue: unknown,
): AppContentSpec | null {
  return contentSpecFromManifest(slug, manifestValue) ?? contentSpecFor(slug);
}
