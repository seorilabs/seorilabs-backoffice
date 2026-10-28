import { boundedText } from "./public-sources";
import { parsePlaySearch } from "./keyword-cycle";
import { playSearchUrl } from "./keyword-cycle";
export { playSearchUrl } from "./keyword-cycle";
export function playPublicName(html: string, id: string): string | undefined {
  if (!/<\/html>\s*$/i.test(html)) throw Error("PLAY_RESPONSE_TRUNCATED");
  if (/recaptcha|unusual traffic|consent.google.com\/m/i.test(html)) throw Error("PLAY_BLOCKED");
  if (!html.includes(`"${id}"`)) return undefined;
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const data=JSON.parse(match[1]) as {"@type"?:unknown;name?:unknown};
    if (data?.["@type"] === "SoftwareApplication" && typeof data.name === "string" && data.name.length > 0 && data.name.length <= 300) return data.name;
  }
  return undefined;
}
export function createPlaySearchClient(input: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}) {
  const impl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let last = 0;
  async function request(url: string) {
    for (let attempt = 0; ; attempt++) {
      await sleep(Math.max(0, 5000 - (Date.now() - last))); last = Date.now();
      try {
        const response = await impl(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
        if (!response.ok) { await response.body?.cancel(); throw Error(`PLAY_HTTP_${response.status}`); }
        return await boundedText(response, 8 * 1024 * 1024);
      } catch (error) {
        if (attempt >= 2 || /PLAY_HTTP_(?!429|500|502|503|504)|SOURCE_RESPONSE_TOO_LARGE/.test(String(error))) throw error;
        await sleep(5000 * (attempt + 1));
      }
    }
  }
  return {
    search: async (term: string, country: string, language: string) => parsePlaySearch(await request(playSearchUrl(term, country, language))),
    publicListing: async (id: string, country: string) => {
      const html = await request(`https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}&hl=en&gl=${country.toUpperCase()}`);
      return playPublicName(html,id);
    },
  };
}
