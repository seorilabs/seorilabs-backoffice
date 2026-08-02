import type { PlatformAppIapCatalog } from "@/lib/platform/client";

/** 느린 이전 앱 응답을 현재 앱 폼에 투영하지 않는 fail-closed 결합이다. */
export function platformCatalogForApp(
  catalog: PlatformAppIapCatalog | null,
  appSlug: string,
): PlatformAppIapCatalog | null {
  return catalog?.appId === appSlug ? catalog : null;
}

export function platformEntitlementAllowedForApp(
  catalog: PlatformAppIapCatalog | null,
  appSlug: string,
  entitlementId: string,
): boolean {
  return (
    platformCatalogForApp(catalog, appSlug)?.entitlements.includes(
      entitlementId,
    ) === true
  );
}
