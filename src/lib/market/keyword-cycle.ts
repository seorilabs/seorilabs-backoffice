import { metricDayOf, metricDayStart, shiftMetricDay } from "@/lib/analytics/metric-day";
export type KeywordMarket = "app-store" | "google-play";
export const keywordSource = (market: KeywordMarket) => market === "app-store" ? "apple-search-api" : "google-play-web";
export const marketLabel = (market?: string) => market === "google-play" ? "Google Play 웹" : "App Store";
export function keywordCycle(now: Date) {
  let day = metricDayOf(now);
  const minutes = (now.getTime() - metricDayStart(day).getTime()) / 60_000;
  const slots = [440, 800, 1220];
  let index = slots.findLastIndex(value => minutes >= value);
  if (index < 0) { day = shiftMetricDay(day, -1); index = 2; }
  const slot = ["0720", "1320", "2020"][index];
  return { id: `${day}-${slot}`, start: new Date(metricDayStart(day).getTime() + slots[index] * 60_000), reportSlot: ["0840", "1440", "2140"][index], day };
}
/** 검증한 search_results 본문만 읽는다. 구조가 바뀌면 순위를 만들지 않는다. */
export function parsePlaySearch(html: string): string[] {
  if (!/<\/html>\s*$/i.test(html)) throw Error("PLAY_RESPONSE_TRUNCATED");
  if (/recaptcha|unusual traffic|consent.google.com\/m/i.test(html)) throw Error("PLAY_BLOCKED");
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const clusters = [...body.matchAll(/<section>\s*<header class="oVnAB K6hyTe"><\/header>([\s\S]*?)<\/section>/g)];
  if (clusters.length !== 1) {
    if (!clusters.length && !/\/store\/apps\/details\?id=/.test(body) && /<section>[^]*?>No results for [^]*?<\/section>/.test(body)) return [];
    throw Error("PLAY_PARSE_FAILED");
  }
  const section = clusters[0][1];
  const cards = section.split(/<div\b[^>]*role="listitem"[^>]*>/).slice(1);
  if (!cards.length) throw Error("PLAY_PARSE_FAILED");
  const ids: string[] = [];
  for (const card of cards) {
    if (/\bSponsored\b|\bAdvertisement\b|aria-label="Ad"|>Ad<|>광고</i.test(card)) continue;
    const links = [...card.matchAll(/<a\b[^>]*href="\/store\/apps\/details\?id=([A-Za-z0-9_.]+)(?:&amp;[^"<>]*)?"/g)];
    const unique = [...new Set(links.map(match => match[1]))];
    if (unique.length !== 1) throw Error("PLAY_PARSE_FAILED");
    if (!ids.includes(unique[0])) ids.push(unique[0]);
  }
  if (!ids.length || ids.length > 200) throw Error("PLAY_PARSE_FAILED");
  return ids;
}

export function playSearchUrl(term: string, country: string, language = "en") {
  const url = new URL("https://play.google.com/store/search");
  for (const [key,value] of Object.entries({q:term,c:"apps",hl:language,gl:country.toUpperCase()})) url.searchParams.set(key,value);
  return url.href;
}

export function brandKeyword(term: string, names: string[]) {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const query = normalize(term);
  return names.some(name => {
    const brand = normalize(name.split(/[:：]/)[0]);
    return Boolean(brand && query && query.includes(brand));
  });
}
