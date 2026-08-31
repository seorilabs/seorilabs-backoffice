import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { fetch as undiciFetch, ProxyAgent } from "undici";

import { readBoundSecretFile } from "@/lib/control-plane/seori-auth-agent-transport";

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SPIFFE_ID = /^spiffe:\/\/seorilabs\.local\/ns\/[a-z0-9-]{1,63}\/sa\/[a-z0-9-]{1,63}$/u;

function canonicalHostname(value: string): string {
  const hostname = value.trim().toLowerCase();
  if (!HOSTNAME.test(hostname) || isIP(hostname) !== 0) {
    throw new Error("SEORI_EGRESS_HOST_INVALID");
  }
  return hostname;
}

export function exactHostSet(raw: string): ReadonlySet<string> {
  const values = raw.split(",").map(canonicalHostname);
  if (values.length < 1 || values.length > 32 || new Set(values).size !== values.length) {
    throw new Error("SEORI_EGRESS_HOST_ALLOWLIST_INVALID");
  }
  return new Set(values);
}

export function exactSpiffeSet(raw: string): ReadonlySet<string> {
  const values = raw.split(",").map((value) => value.trim());
  if (
    values.length < 1
    || values.length > 16
    || values.some((value) => !SPIFFE_ID.test(value))
    || new Set(values).size !== values.length
  ) {
    throw new Error("SEORI_EGRESS_SPIFFE_ALLOWLIST_INVALID");
  }
  return new Set(values);
}

export function parseConnectAuthority(
  authority: string,
  allowedHosts: ReadonlySet<string>,
): { hostname: string; port: 443 } {
  if (
    authority.length > 260
    || authority.includes("@")
    || authority.includes("/")
    || authority.includes("?")
    || authority.includes("#")
  ) throw new Error("SEORI_EGRESS_CONNECT_TARGET_INVALID");
  const match = /^(?<hostname>[A-Za-z0-9.-]+):(?<port>[0-9]{1,5})$/u.exec(authority);
  if (!match?.groups || match.groups.port !== "443") {
    throw new Error("SEORI_EGRESS_CONNECT_TARGET_INVALID");
  }
  const hostname = canonicalHostname(match.groups.hostname);
  if (!allowedHosts.has(hostname)) throw new Error("SEORI_EGRESS_HOST_NOT_ALLOWED");
  return { hostname, port: 443 };
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function ipv4InCidr(address: number, base: string, prefix: number): boolean {
  const baseNumber = ipv4Number(base);
  if (baseNumber === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (baseNumber & mask);
}

const NON_PUBLIC_IPV4 = Object.freeze([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const);

export function isPublicConnectAddress(address: string, family: number): boolean {
  if (family === 4) {
    const numeric = ipv4Number(address);
    return numeric !== null && !NON_PUBLIC_IPV4.some(([base, prefix]) => ipv4InCidr(numeric, base, prefix));
  }
  if (family !== 6 || isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  return !(
    normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/u.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:")
    || normalized.startsWith("::ffff:")
  );
}

export async function resolvePublicConnectAddress(
  hostname: string,
  lookup: typeof dnsLookup = dnsLookup,
): Promise<{ address: string; family: 4 | 6 }> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  if (
    results.length < 1
    || results.length > 64
    || results.some(({ address, family }) => !isPublicConnectAddress(address, family))
  ) throw new Error("SEORI_EGRESS_DNS_RESULT_REJECTED");
  const unique = [...new Map(results.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()]
    .sort((left, right) => left.family - right.family || left.address.localeCompare(right.address));
  const selected = unique[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error("SEORI_EGRESS_DNS_RESULT_REJECTED");
  }
  return { address: selected.address, family: selected.family };
}

export function exactPeerSpiffeIdentity(
  subjectAltName: string | undefined,
  allowed: ReadonlySet<string>,
): string {
  const identities = (subjectAltName ?? "")
    .split(/,\s*/u)
    .filter((entry) => entry.startsWith("URI:"))
    .map((entry) => entry.slice("URI:".length));
  if (identities.length !== 1 || !allowed.has(identities[0])) {
    throw new Error("SEORI_EGRESS_CLIENT_IDENTITY_REJECTED");
  }
  return identities[0];
}

export interface ExactMtlsProxyClient {
  fetch: typeof globalThis.fetch;
  close: () => Promise<void>;
}

export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  errorCode: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !/^[A-Z][A-Z0-9_]+$/u.test(errorCode)) {
    throw new Error("SEORI_EGRESS_RESPONSE_BOUND_INVALID");
  }
  const declared = response.headers.get("content-length")?.trim();
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    try {
      await response.body?.cancel();
    } catch {
      // stream cancel 실패가 bounded rejection을 바꾸지 않게 한다.
    }
    throw new Error(errorCode);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      value.fill(0);
      total += chunk.length;
      if (total > maxBytes) {
        chunk.fill(0);
        try {
          await reader.cancel();
        } catch {
          // stream cancel 실패가 bounded rejection을 바꾸지 않게 한다.
        }
        throw new Error(errorCode);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    chunks.forEach((chunk) => chunk.fill(0));
    reader.releaseLock();
  }
}

export async function createExactMtlsProxyClient(input: {
  root: string;
  proxyOrigin: string;
  proxyServerName: string;
  allowedHosts: ReadonlySet<string>;
  targetCa?: Buffer;
  caPath?: string;
  certificatePath?: string;
  privateKeyPath?: string;
}): Promise<ExactMtlsProxyClient> {
  const allowedHosts = new Set(input.allowedHosts);
  if (allowedHosts.size < 1 || allowedHosts.size > 32) {
    throw new Error("SEORI_EGRESS_HOST_ALLOWLIST_INVALID");
  }
  let origin: URL;
  try {
    origin = new URL(input.proxyOrigin);
  } catch {
    throw new Error("SEORI_EGRESS_PROXY_ORIGIN_INVALID");
  }
  const serverName = canonicalHostname(input.proxyServerName);
  if (
    origin.protocol !== "https:"
    || origin.hostname !== serverName
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
    || (origin.port && origin.port !== "8443")
  ) throw new Error("SEORI_EGRESS_PROXY_ORIGIN_INVALID");
  let ca: Buffer | undefined;
  let certificate: Buffer | undefined;
  let privateKey: Buffer | undefined;
  try {
    ca = await readBoundSecretFile({
      root: input.root,
      relativePath: input.caPath ?? "egress/ca.pem",
      allowGroupRead: true,
    });
    certificate = await readBoundSecretFile({
      root: input.root,
      relativePath: input.certificatePath ?? "egress/tls.crt",
      allowGroupRead: true,
    });
    privateKey = await readBoundSecretFile({
      root: input.root,
      relativePath: input.privateKeyPath ?? "egress/tls.key",
      allowGroupRead: true,
    });
  } catch (error) {
    ca?.fill(0);
    certificate?.fill(0);
    privateKey?.fill(0);
    throw new Error("SEORI_EGRESS_PROXY_TLS_BINDING_INVALID", { cause: error });
  }
  let dispatcher: ProxyAgent;
  try {
    dispatcher = new ProxyAgent({
      uri: origin.origin,
      proxyTls: {
        ca,
        cert: certificate,
        key: privateKey,
        servername: serverName,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        rejectUnauthorized: true,
      },
      requestTls: {
        ...(input.targetCa ? { ca: input.targetCa } : {}),
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        rejectUnauthorized: true,
      },
    });
  } catch (error) {
    ca.fill(0);
    certificate.fill(0);
    privateKey.fill(0);
    throw new Error("SEORI_EGRESS_PROXY_CLIENT_INVALID", { cause: error });
  }
  let closed = false;
  return Object.freeze({
    fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
      if (closed) throw new Error("SEORI_EGRESS_PROXY_CLIENT_CLOSED");
      const rawUrl = request instanceof Request ? request.url : request.toString();
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        throw new Error("SEORI_EGRESS_REQUEST_URL_INVALID");
      }
      if (
        url.protocol !== "https:"
        || (url.port && url.port !== "443")
        || url.username
        || url.password
        || !allowedHosts.has(url.hostname.toLowerCase())
      ) throw new Error("SEORI_EGRESS_REQUEST_URL_REJECTED");
      const proxyInit = Object.assign({}, init ?? {}, {
        dispatcher,
        redirect: "error" as const,
      });
      return undiciFetch(request as never, proxyInit as never) as unknown as Promise<Response>;
    }) as typeof globalThis.fetch,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await dispatcher.close();
      } finally {
        ca.fill(0);
        certificate.fill(0);
        privateKey.fill(0);
      }
    },
  });
}
