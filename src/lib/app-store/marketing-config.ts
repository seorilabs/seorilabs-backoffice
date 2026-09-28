export function appStoreMarketingUrls(config: unknown): Record<string, string> {
  if (!config || typeof config !== "object") return {};
  const localizations = (config as { localizations?: unknown }).localizations;
  if (!localizations || typeof localizations !== "object") return {};
  const urls: Record<string, string> = {};
  for (const [locale, value] of Object.entries(localizations)) {
    if (!value || typeof value !== "object") continue;
    const url = (value as { marketingUrl?: unknown }).marketingUrl;
    if (url == null || url === "") continue;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error(`App Store ${locale} marketingUrl은 HTTPS 주소여야 합니다.`);
    }
    urls[locale] = url;
  }
  return urls;
}

/** 태그가 가리키는 정확한 커밋의 마켓 원장을 읽는다. */
export async function loadAppStoreMarketingUrls(repoFullName: string, sha: string): Promise<Record<string, string>> {
  const { getRepoJsonFile } = await import("@/lib/github/read");
  const config = await getRepoJsonFile(repoFullName, "app-store/app-store.config.json", sha);
  return appStoreMarketingUrls(config);
}
