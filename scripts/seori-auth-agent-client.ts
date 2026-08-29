import { request as httpsRequest, type RequestOptions } from "node:https";
import { z } from "zod";

import {
  assertPublicAgentResponse,
  parseExactHttpsOrigin,
  readBoundSecretFile,
  seoriAuthPublicRequestSchema,
} from "@/lib/control-plane/seori-auth-agent-transport";

const BODY_LIMIT = 6 * 1024 * 1024;
const RESPONSE_LIMIT = 512 * 1024;
z.literal("mtls").parse(process.env.SEORI_AUTH_AGENT_CLIENT_TRANSPORT?.trim());

async function stdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const copy = Buffer.from(chunk as Buffer);
    bytes += copy.length;
    if (bytes > BODY_LIMIT) {
      copy.fill(0);
      chunks.forEach((entry) => entry.fill(0));
      throw new Error("SEORI_AUTH_CLIENT_REQUEST_TOO_LARGE");
    }
    chunks.push(copy);
  }
  const encoded = Buffer.concat(chunks);
  try {
    return seoriAuthPublicRequestSchema.parse(JSON.parse(encoded.toString("utf8")));
  } finally {
    encoded.fill(0);
    chunks.forEach((entry) => entry.fill(0));
  }
}

function executeRequest(options: RequestOptions, encoded: Buffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(options, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT) request.destroy(new Error("SEORI_AUTH_CLIENT_RESPONSE_TOO_LARGE"));
        else chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        const payload = Buffer.concat(chunks);
        try {
          const parsed = assertPublicAgentResponse(JSON.parse(payload.toString("utf8")));
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(new Error("SEORI_AUTH_CLIENT_REQUEST_REJECTED"));
            return;
          }
          resolve(parsed);
        } catch (error) {
          reject(error);
        } finally {
          payload.fill(0);
          chunks.forEach((entry) => entry.fill(0));
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("SEORI_AUTH_CLIENT_TIMEOUT")));
    request.once("error", reject);
    request.end(encoded);
  });
}

async function main() {
  const requestBody = await stdinJson();
  const encoded = Buffer.from(JSON.stringify(requestBody), "utf8");
  try {
    const root = process.env.SEORI_AUTH_AGENT_CLIENT_ROOT?.trim() || "/var/run/seori-auth-agent-client";
    const origin = parseExactHttpsOrigin(process.env.SEORI_AUTH_AGENT_ORIGIN?.trim() || "");
    const [ca, certificate, key] = await Promise.all([
      readBoundSecretFile({ root, relativePath: "ca.pem", allowGroupRead: true }),
      readBoundSecretFile({ root, relativePath: "tls.crt", allowGroupRead: true }),
      readBoundSecretFile({ root, relativePath: "tls.key", allowGroupRead: true }),
    ]);
    try {
      const response = await executeRequest({
        protocol: "https:",
        hostname: origin.hostname,
        port: origin.port ? Number(origin.port) : 443,
        servername: origin.hostname,
        method: "POST",
        path: "/v1/execute",
        ca,
        cert: certificate,
        key,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        headers: { "content-type": "application/json", "content-length": String(encoded.length) },
        timeout: 30_000,
      }, encoded);
      const output = Buffer.from(`${JSON.stringify(assertPublicAgentResponse(response))}\n`, "utf8");
      process.stdout.write(output, () => output.fill(0));
    } finally {
      ca.fill(0);
      certificate.fill(0);
      key.fill(0);
    }
  } finally {
    encoded.fill(0);
  }
}

main().catch(() => {
  console.error("seori-auth 요청 실패 code=CLIENT_REJECTED");
  process.exitCode = 1;
});
