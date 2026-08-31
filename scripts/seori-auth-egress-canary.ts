import { connect as connectTls } from "node:tls";

import {
  createExactMtlsProxyClient,
  exactHostSet,
} from "@/lib/control-plane/mtls-egress-proxy";
import { readBoundSecretFile } from "@/lib/control-plane/seori-auth-agent-transport";

const ROOT = "/var/run/seori-auth-egress-canary";
const PROXY_SERVER_NAME = "seori-auth-egress-proxy.auth-broker.svc.cluster.local";
const PROXY_PORT = 8443;
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024;

async function expectRedirectRejected(proxy: {
  fetch: typeof globalThis.fetch;
}): Promise<void> {
  try {
    const response = await proxy.fetch("https://api.github.com/repos/seorilabs/.github/tarball/main", {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "seorilabs-egress-canary/1",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
  } catch (error) {
    if (error instanceof Error && error.message === "SEORI_EGRESS_REDIRECT_REJECTED") return;
    throw new Error("SEORI_EGRESS_CANARY_REDIRECT_CHECK_FAILED", { cause: error });
  }
  throw new Error("SEORI_EGRESS_CANARY_REDIRECT_NOT_REJECTED");
}

async function expectConnectRejected(input: {
  authority: string;
  ca: Buffer;
  certificate: Buffer;
  privateKey: Buffer;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connectTls({
      host: PROXY_SERVER_NAME,
      port: PROXY_PORT,
      servername: PROXY_SERVER_NAME,
      ca: input.ca,
      cert: input.certificate,
      key: input.privateKey,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      timeout: TIMEOUT_MS,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      chunks.forEach((chunk) => chunk.fill(0));
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("secureConnect", () => {
      socket.write([
        `CONNECT ${input.authority} HTTP/1.1`,
        `Host: ${input.authority}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk: Buffer) => {
      const copy = Buffer.from(chunk);
      chunks.push(copy);
      bytes += copy.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        finish(new Error("SEORI_EGRESS_CANARY_RESPONSE_TOO_LARGE"));
        return;
      }
      const response = Buffer.concat(chunks);
      try {
        const end = response.indexOf("\r\n\r\n");
        if (end < 0) return;
        const statusLine = response.subarray(0, response.indexOf("\r\n")).toString("ascii");
        if (statusLine !== "HTTP/1.1 403 Forbidden") {
          finish(new Error("SEORI_EGRESS_CANARY_REJECTION_MISMATCH"));
          return;
        }
        finish();
      } finally {
        response.fill(0);
      }
    });
    socket.once("timeout", () => finish(new Error("SEORI_EGRESS_CANARY_TIMEOUT")));
    socket.once("error", () => finish(new Error("SEORI_EGRESS_CANARY_TRANSPORT_FAILED")));
    socket.once("end", () => {
      if (!settled) finish(new Error("SEORI_EGRESS_CANARY_RESPONSE_INCOMPLETE"));
    });
  });
}

async function main(): Promise<void> {
  const proxy = await createExactMtlsProxyClient({
    root: ROOT,
    proxyOrigin: `https://${PROXY_SERVER_NAME}:${PROXY_PORT}`,
    proxyServerName: PROXY_SERVER_NAME,
    allowedHosts: exactHostSet("api.github.com"),
  });
  let ca: Buffer | undefined;
  let certificate: Buffer | undefined;
  let privateKey: Buffer | undefined;
  try {
    const response = await proxy.fetch("https://api.github.com/", {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "seorilabs-egress-canary/1",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status !== 200) throw new Error("SEORI_EGRESS_CANARY_POSITIVE_FAILED");
    await response.body?.cancel();
    await expectRedirectRejected(proxy);

    ca = await readBoundSecretFile({ root: ROOT, relativePath: "egress/ca.pem", allowGroupRead: true });
    certificate = await readBoundSecretFile({
      root: ROOT,
      relativePath: "egress/tls.crt",
      allowGroupRead: true,
    });
    privateKey = await readBoundSecretFile({
      root: ROOT,
      relativePath: "egress/tls.key",
      allowGroupRead: true,
    });
    for (const authority of [
      "api.github.com.evil.invalid:443",
      "github.com:443",
      "127.0.0.1:443",
      "api.github.com:80",
    ]) {
      await expectConnectRejected({ authority, ca, certificate, privateKey });
    }
    console.log('{"state":"CANARY_OK","secretExposed":false,"positive":1,"rejected":5,"redirectRejected":1}');
  } finally {
    ca?.fill(0);
    certificate?.fill(0);
    privateKey?.fill(0);
    await proxy.close();
  }
}

main().catch(() => {
  console.error("[seori-auth-egress-canary] 종료 code=CANARY_FAILED");
  process.exitCode = 1;
});
