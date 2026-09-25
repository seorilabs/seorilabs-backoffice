import { SignJWT } from "jose";

export interface GoogleServiceAccountClaims {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

export const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export const GOOGLE_PLAY_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

function cacheKey(claims: GoogleServiceAccountClaims, scope: string): string {
  return `${claims.client_email}|${scope}`;
}

export async function getGoogleAccessToken(input: {
  claims: GoogleServiceAccountClaims;
  scope?: string;
  tokenUri?: string;
  fetchImpl?: typeof fetch;
}): Promise<CachedToken> {
  const scope = input.scope ?? GOOGLE_PLAY_PUBLISHER_SCOPE;
  const tokenUri = input.tokenUri ?? input.claims.token_uri ?? DEFAULT_TOKEN_URI;
  const key = cacheKey(input.claims, scope);
  const now = Math.floor(Date.now() / 1000);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now + 60) {
    return cached;
  }
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(input.claims.client_email)
    .setSubject(input.claims.client_email)
    .setAudience(tokenUri)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(await importPrivateKey(input.claims.private_key));
  const requestImpl = input.fetchImpl ?? fetch;
  const response = await requestImpl(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Google OAuth token exchange failed (${response.status}): ${body.slice(0, 200)}`,
    );
  }
  const payload = (await response.json()) as GoogleTokenResponse;
  const expiresAt = now + payload.expires_in;
  const value: CachedToken = { token: payload.access_token, expiresAt };
  cache.set(key, value);
  return value;
}

export function resetGoogleTokenCache(): void {
  cache.clear();
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("globalThis.crypto.subtle missing");
  }
  const pemBody = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const der = base64ToBytes(pemBody);
  return subtle.importKey(
    "pkcs8",
    der as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
