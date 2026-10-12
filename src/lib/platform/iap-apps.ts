import type { PlatformAppIapCatalog } from "./client";

export interface IapAppCandidate {
  slug: string;
  displayName: string;
  platformAppId: string | null;
  type: string;
  status: string;
}

export interface WritableIapApp { slug: string; displayName: string }
export interface IapAppSelection {
  apps: WritableIapApp[];
  unavailableCount: number;
  emptyCount: number;
}

export async function selectWritableIapApps(
  candidates: readonly IapAppCandidate[],
  catalog: (appId: string) => Promise<PlatformAppIapCatalog>,
): Promise<IapAppSelection> {
  const games = candidates.filter((app) => app.type === "GAME" && app.status === "ACTIVE" && app.platformAppId?.trim());
  const checked: Array<WritableIapApp | null> = games.map(() => null);
  let next = 0, unavailableCount = 0, emptyCount = 0;
  await Promise.all(Array.from({length: Math.min(4, games.length)}, async () => {
    while (next < games.length) {
      const index = next++;
      const app = games[index];
      const appId = app.platformAppId!.trim();
      try {
        const result = await catalog(appId);
        if (result.appId !== appId || !Array.isArray(result.entitlements) || result.entitlements.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id))) {
          unavailableCount++;
        } else if (!result.entitlements.length) {
          emptyCount++;
        } else {
          checked[index] = {slug: appId, displayName: app.displayName};
        }
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        if (code !== "auth_forbidden" && code !== "not_found") unavailableCount++;
      }
    }
  }));
  return {apps: checked.filter((app): app is WritableIapApp => app !== null), unavailableCount, emptyCount};
}

export function initialIapAppSlug(apps: readonly WritableIapApp[], requested?: string): string {
  return requested === undefined ? apps[0]?.slug ?? "" : apps.some((app) => app.slug === requested) ? requested : "";
}
