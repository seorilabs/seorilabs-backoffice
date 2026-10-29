import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackSignature(input: { body: string; timestamp: string | null; signature: string | null; secret: string; now?: number }): boolean {
  if (!input.secret || !input.timestamp || !/^\d{10,12}$/.test(input.timestamp) || !input.signature || !/^v0=[a-f0-9]{64}$/.test(input.signature)) return false;
  if (Math.abs((input.now ?? Date.now()) / 1000 - Number(input.timestamp)) > 300) return false;
  const expected = "v0=" + createHmac("sha256", input.secret).update(`v0:${input.timestamp}:${input.body}`).digest("hex");
  return timingSafeEqual(Buffer.from(input.signature), Buffer.from(expected));
}
