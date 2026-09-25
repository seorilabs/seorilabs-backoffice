import { createHmac, timingSafeEqual } from "node:crypto";

// App Store Connect signs the exact HTTP body with HMAC-SHA256.
export function verifyAppleWebhookSignature(input: {
  body: string;
  signature: string | null;
  secret: string;
}): boolean {
  if (!input.secret || !input.signature?.startsWith("hmacsha256=")) return false;
  const supplied = input.signature.slice("hmacsha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(supplied)) return false;
  const actual = createHmac("sha256", input.secret).update(input.body).digest();
  return timingSafeEqual(actual, Buffer.from(supplied, "hex"));
}
