import { connect as connectTcp } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import type { TLSSocket } from "node:tls";

import {
  exactClientHostPolicies,
  exactPeerSpiffeIdentity,
  parseConnectAuthority,
  resolvePublicConnectAddress,
} from "@/lib/control-plane/mtls-egress-proxy";
import { readBoundSecretFile } from "@/lib/control-plane/seori-auth-agent-transport";

const ROOT = process.env.SEORI_EGRESS_PROXY_ROOT?.trim() || "/var/run/seori-auth-egress-proxy";
const PORT = Number(process.env.SEORI_EGRESS_PROXY_PORT ?? "8443");
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_HEAD_BYTES = 8 * 1024;

if (!Number.isSafeInteger(PORT) || PORT < 1024 || PORT > 65535) {
  throw new Error("SEORI_EGRESS_PROXY_PORT_INVALID");
}

const clientHostPolicies = exactClientHostPolicies(
  process.env.SEORI_EGRESS_CLIENT_HOST_POLICIES?.trim() || "",
);
const allowedClientSpiffeIds = new Set(clientHostPolicies.keys());

function reject(socket: TLSSocket, status = "403 Forbidden"): void {
  if (!socket.destroyed && socket.writable) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } else {
    socket.destroy();
  }
}

async function main(): Promise<void> {
  let clientCa: Buffer | undefined;
  let certificate: Buffer | undefined;
  let privateKey: Buffer | undefined;
  try {
    clientCa = await readBoundSecretFile({
      root: ROOT,
      relativePath: "server/client-ca.pem",
      allowGroupRead: true,
    });
    certificate = await readBoundSecretFile({
      root: ROOT,
      relativePath: "server/tls.crt",
      allowGroupRead: true,
    });
    privateKey = await readBoundSecretFile({
      root: ROOT,
      relativePath: "server/tls.key",
      allowGroupRead: true,
    });
  } catch (error) {
    clientCa?.fill(0);
    certificate?.fill(0);
    privateKey?.fill(0);
    throw new Error("SEORI_EGRESS_PROXY_TLS_BINDING_INVALID", { cause: error });
  }
  const server = createHttpsServer({
    ca: clientCa,
    cert: certificate,
    key: privateKey,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    maxHeaderSize: 16 * 1024,
  }, (_request, response) => {
    response.writeHead(404, {
      "cache-control": "no-store",
      "content-length": "0",
      connection: "close",
    });
    response.end();
  });
  server.maxConnections = 64;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  server.on("connect", (request, rawSocket, head) => {
    const socket = rawSocket as TLSSocket;
    void (async () => {
      let upstream: ReturnType<typeof connectTcp> | undefined;
      try {
        if (
          !socket.authorized
          || head.length > MAX_HEAD_BYTES
          || request.headers["proxy-authorization"]
          || request.headers.host !== request.url
        ) {
          throw new Error("SEORI_EGRESS_CONNECT_REJECTED");
        }
        const peer = socket.getPeerCertificate(true);
        const clientIdentity = exactPeerSpiffeIdentity(peer.subjectaltname, allowedClientSpiffeIds);
        const allowedHosts = clientHostPolicies.get(clientIdentity);
        if (!allowedHosts) throw new Error("SEORI_EGRESS_CLIENT_POLICY_NOT_FOUND");
        const target = parseConnectAuthority(request.url || "", allowedHosts);
        const resolved = await resolvePublicConnectAddress(target.hostname);
        upstream = connectTcp({
          host: resolved.address,
          port: target.port,
          family: resolved.family,
          timeout: CONNECT_TIMEOUT_MS,
          noDelay: true,
        });
        await new Promise<void>((resolve, rejectPromise) => {
          upstream?.once("connect", resolve);
          upstream?.once("timeout", () => rejectPromise(new Error("SEORI_EGRESS_CONNECT_TIMEOUT")));
          upstream?.once("error", rejectPromise);
        });
        upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream?.destroy());
        socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
        socket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: seori-auth-egress\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.once("error", () => socket.destroy());
        socket.once("error", () => upstream?.destroy());
        upstream.once("close", () => socket.destroy());
        socket.once("close", () => upstream?.destroy());
        socket.pipe(upstream);
        upstream.pipe(socket);
      } catch {
        upstream?.destroy();
        reject(socket);
      }
    })();
  });

  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed && socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[seori-auth-egress-proxy] ready port=${PORT} allowedClients=${clientHostPolicies.size}`);
  });
  const shutdown = () => server.close(() => {
    clientCa.fill(0);
    certificate.fill(0);
    privateKey.fill(0);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(() => {
  console.error("[seori-auth-egress-proxy] 종료 code=PROXY_FATAL");
  process.exitCode = 1;
});
