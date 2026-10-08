import { createHash } from "node:crypto";
import { Agent, fetch as publicFetch } from "undici";
import { resolvePublicConnectAddress } from "@/lib/control-plane/mtls-egress-proxy";

/** DNS 검증 결과 주소로 연결을 고정한다. 리디렉션도 매번 새로 검증한다. */
export async function checkPublicLink(input: string): Promise<number> {
  let url = new URL(input);
  for (let hop = 0; hop < 4; hop++) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      throw new Error("PUBLIC_LINK_REQUIRED");
    const address = await resolvePublicConnectAddress(url.hostname);
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
    });
    try {
      const response = await publicFetch(url, {
        method: "GET",
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { range: "bytes=0-1023" },
      });
      await response.body?.cancel();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("INVALID_REDIRECT");
        url = new URL(location, url);
        continue;
      }
      return response.status;
    } finally {
      await dispatcher.close();
    }
  }
  throw new Error("REDIRECT_LIMIT");
}

export function publicLinkTarget(input: string): string {
  return (
    new URL(input).hostname.slice(0, 100) + ":" + createHash("sha256").update(input).digest("hex")
  );
}
