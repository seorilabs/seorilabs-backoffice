import { createRemoteJWKSet, jwtVerify } from "jose";

const APPLE_JWKS_URL = new URL("https://appleid.apple.com/auth/keys");
const APPLE_WEBHOOK_ISSUER = "appstoreconnect-v1";

export const APPLE_JWKS = createRemoteJWKSet(APPLE_JWKS_URL, {
  cooldownDuration: 60_000,
});

export const DEFAULT_WEBHOOK_AUDIENCE =
  "https://backoffice.vzyx.xyz/api/webhooks/appstore";

export interface AppleWebhookTokenPayload {
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  /** Apple JWS payload body — WebhookEvent */
  raw: unknown;
}

export async function verifyAppleWebhookToken(input: {
  token: string;
  expectedAudience?: string;
}): Promise<AppleWebhookTokenPayload> {
  const { payload } = await jwtVerify(input.token, APPLE_JWKS, {
    audience: input.expectedAudience ?? DEFAULT_WEBHOOK_AUDIENCE,
    issuer: APPLE_WEBHOOK_ISSUER,
    clockTolerance: 60,
  });
  const iss = typeof payload.iss === "string" ? payload.iss : APPLE_WEBHOOK_ISSUER;
  return {
    iss,
    aud: payload.aud as string | string[],
    iat: Number(payload.iat ?? 0),
    exp: Number(payload.exp ?? 0),
    raw: payload as unknown,
  };
}
