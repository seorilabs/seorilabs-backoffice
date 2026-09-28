import assert from "node:assert/strict";
import test from "node:test";
import { appStoreMarketingUrls } from "@/lib/app-store/marketing-config";

test("앱 심사 원장의 언어별 HTTPS 마케팅 URL만 읽는다", () => {
  assert.deepEqual(appStoreMarketingUrls({
    localizations: {
      ko: { marketingUrl: "https://www.seorilabs.com/" },
      "en-US": { marketingUrl: "https://www.seorilabs.com/" },
      ja: { name: "Example" },
    },
  }), { ko: "https://www.seorilabs.com/", "en-US": "https://www.seorilabs.com/" });
  assert.throws(() => appStoreMarketingUrls({ localizations: { ko: { marketingUrl: "http://example.com" } } }), /HTTPS/);
});
