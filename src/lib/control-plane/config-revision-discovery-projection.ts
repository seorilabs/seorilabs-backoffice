import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";

const MARKET_ORDER = ["google-play", "app-store", "apps-in-toss"] as const;
const RELEASE_CHANNEL = {
  "google-play": "internal",
  "app-store": "testflight",
  "apps-in-toss": "private",
} as const;

/**
 * exact-SHA BuildTarget 사실만 desired state로 투영한다. 법적 선언, provider
 * 상태, localization, asset은 discovery가 증명할 수 없으므로 절대 복사하지 않는다.
 */
export function projectDiscoveryConfigPayload(input: {
  sourceSha: string;
  buildTargets: Array<{ market: string | null; observedSha: string | null }>;
}): Record<string, unknown> | null {
  const observedMarkets = new Set(input.buildTargets
    .filter((target) => target.observedSha?.toLowerCase() === input.sourceSha.toLowerCase())
    .map((target) => target.market)
    .filter((market): market is typeof MARKET_ORDER[number] => (
      market !== null && MARKET_ORDER.includes(market as typeof MARKET_ORDER[number])
    )));
  const markets = MARKET_ORDER
    .filter((market) => observedMarkets.has(market))
    .map((market) => ({
      market,
      enabled: true,
      locales: [],
      releaseChannel: RELEASE_CHANNEL[market],
    }));
  if (markets.length === 0) return null;
  return configRevisionPayloadSchema.parse({ schemaVersion: 1, markets });
}
