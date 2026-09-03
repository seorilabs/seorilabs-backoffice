import { request as httpRequest, type RequestOptions } from "node:http";
import { z } from "zod";

import {
  assertPrivateAgentRelaySocket,
  assertPublicAgentResponse,
  seoriAuthPublicRequestSchema,
} from "@/lib/control-plane/seori-auth-agent-transport";

const BODY_LIMIT = 6 * 1024 * 1024;
const RESPONSE_LIMIT = 512 * 1024;
z.literal("unix-relay").parse(process.env.SEORI_AUTH_AGENT_CLIENT_TRANSPORT?.trim());

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
    const request = httpRequest(options, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const rejectResponse = (error: Error) => {
        if (settled) return;
        settled = true;
        chunks.forEach((entry) => entry.fill(0));
        reject(error);
      };
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        const copy = Buffer.from(chunk);
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT) {
          copy.fill(0);
          rejectResponse(new Error("SEORI_AUTH_CLIENT_RESPONSE_TOO_LARGE"));
          request.destroy();
          return;
        }
        chunks.push(copy);
      });
      response.once("aborted", () => rejectResponse(new Error("SEORI_AUTH_CLIENT_RESPONSE_ABORTED")));
      response.once("error", () => rejectResponse(new Error("SEORI_AUTH_CLIENT_RESPONSE_FAILED")));
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const payload = Buffer.concat(chunks);
        try {
          const contentType = String(response.headers["content-type"] ?? "")
            .split(";", 1)[0]?.trim().toLowerCase();
          if (contentType !== "application/json") throw new Error("SEORI_AUTH_CLIENT_RESPONSE_TYPE_INVALID");
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
    const socketPath = process.env.SEORI_AUTH_AGENT_SOCKET?.trim() || "";
    await assertPrivateAgentRelaySocket(socketPath);
    const response = await executeRequest({
      socketPath,
      method: "POST",
      path: "/v1/execute",
      headers: { "content-type": "application/json", "content-length": String(encoded.length) },
      timeout: 30_000,
    }, encoded);
    const output = Buffer.from(`${JSON.stringify(assertPublicAgentResponse(response))}\n`, "utf8");
    process.stdout.write(output, () => output.fill(0));
  } finally {
    encoded.fill(0);
  }
}

main().catch(() => {
  console.error("seori-auth 요청 실패 code=CLIENT_REJECTED");
  process.exitCode = 1;
});
