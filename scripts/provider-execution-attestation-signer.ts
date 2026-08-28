import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import {
  createServer,
  request as httpsRequest,
  type RequestOptions,
} from "node:https";
import type { TLSSocket } from "node:tls";
import { z } from "zod";

import {
  providerExecutionObservationSchema,
} from "@/lib/control-plane/contracts";
import {
  providerBrokerStageSchema,
  sanitizeProviderBrokerResponse,
} from "@/lib/control-plane/provider-adapter-client";
import { providerExecutionLeaseToken } from "@/lib/control-plane/provider-execution";
import {
  authorizeProviderBrokerRequest,
  claimProviderExecution,
  currentProviderExecutionClaim,
  settleProviderExecution,
} from "@/lib/control-plane/provider-execution-service";
import {
  createRunAttestationNonce,
  runAttestationNonceDigest,
  signRunAttestation,
} from "@/lib/control-plane/provider-execution-signer";
import { ControlPlaneError, recordReauthRequest } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

const BODY_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const workerId = process.env.PROVIDER_EXECUTION_WORKER_ID?.trim() || "provider-execution:rpi5";
const subject = process.env.PROVIDER_EXECUTION_SUBJECT?.trim() || "k8s:platform:provider-execution-worker";
const workerSpiffeId = process.env.PROVIDER_EXECUTION_WORKER_SPIFFE_ID?.trim()
  || "spiffe://seorilabs.local/ns/platform/sa/provider-execution-worker";
const brokerSpiffeId = process.env.PROVIDER_EXECUTION_BROKER_SPIFFE_ID?.trim()
  || "spiffe://seorilabs.local/ns/platform/sa/provider-execution-signer";
const brokerOriginInput = process.env.SEORI_AUTH_BROKER_ORIGIN?.trim();
if (!brokerOriginInput) throw new Error("SEORI_AUTH_BROKER_ORIGIN_REQUIRED");
const brokerOrigin = new URL(brokerOriginInput);
if (
  brokerOrigin.protocol !== "https:"
  || brokerOrigin.pathname !== "/"
  || brokerOrigin.search
  || brokerOrigin.hash
  || brokerOrigin.username
  || brokerOrigin.password
) throw new Error("AUTH_BROKER_ORIGIN_INVALID");
const port = Number(process.env.PROVIDER_EXECUTION_SIGNER_PORT ?? "9443");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error("PROVIDER_EXECUTION_SIGNER_PORT_INVALID");
}

const claimSchema = z.object({
  idempotencyKey: z.string().regex(/^provider-claim:[A-Za-z0-9._:/-]{1,128}:[0-9]{10,16}$/),
  leaseSeconds: z.number().int().min(30).max(300),
}).strict();

const brokerRequestSchema = z.object({
  executionId: z.string().min(1).max(191),
  generation: z.number().int().positive(),
  stage: providerBrokerStageSchema,
  ordinal: z.number().int().min(1).max(20),
  expectedRequestDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const settlementSchema = z.object({
  executionId: z.string().min(1).max(191),
  generation: z.number().int().positive(),
  outcome: z.enum(["COMMAND_ACCEPTED", "OBSERVED", "RESULT_UNKNOWN", "FAILED", "HUMAN_REQUIRED", "APPROVAL_REQUIRED"]),
  observation: providerExecutionObservationSchema.optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_.:-]{0,127}$/).optional(),
  idempotencyKey: z.string().regex(/^provider-settlement:[A-Za-z0-9._:/-]{1,191}$/),
}).strict().superRefine((value, context) => {
  if ((value.outcome === "OBSERVED") !== Boolean(value.observation)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "observation binding invalid" });
  }
  if ((value.outcome === "FAILED" || value.outcome === "APPROVAL_REQUIRED") && !value.errorCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "error code required" });
  }
});

function respond(response: ServerResponse, status: number, body: unknown) {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(encoded.length),
    "cache-control": "no-store",
  });
  response.end(encoded, () => encoded.fill(0));
}

async function readJson(request: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const copy = Buffer.from(chunk as Buffer);
    bytes += copy.length;
    if (bytes > BODY_LIMIT) {
      copy.fill(0);
      for (const buffered of chunks) buffered.fill(0);
      throw new Error("REQUEST_BODY_TOO_LARGE");
    }
    chunks.push(copy);
  }
  const payload = Buffer.concat(chunks);
  try {
    return JSON.parse(payload.toString("utf8"));
  } finally {
    payload.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function assertWorkerPeer(socket: TLSSocket) {
  if (!socket.authorized) throw new Error("WORKER_MTLS_REQUIRED");
  const certificate = socket.getPeerCertificate(true);
  if (certificate.subjectaltname !== `URI:${workerSpiffeId}`) {
    throw new Error("WORKER_SPIFFE_ID_MISMATCH");
  }
}

async function main() {
  const fixedRoot = "/var/run/seori-provider-execution-signer";
  const [
    signerClientCa,
    signerCertificate,
    signerKeyBytes,
    brokerCa,
    brokerCertificate,
    brokerKeyBytes,
    attestationKeyBytes,
    queueSigningKey,
  ] = await Promise.all([
    readFile(`${fixedRoot}/server/client-ca.pem`),
    readFile(`${fixedRoot}/server/tls.crt`),
    readFile(`${fixedRoot}/server/tls.key`),
    readFile(`${fixedRoot}/broker/ca.pem`),
    readFile(`${fixedRoot}/broker/tls.crt`),
    readFile(`${fixedRoot}/broker/tls.key`),
    readFile(`${fixedRoot}/attestation/private.pem`),
    readFile(`${fixedRoot}/queue-lease/signing.key`),
  ]);
  if (queueSigningKey.length < 32) throw new Error("PROVIDER_EXECUTION_LEASE_SIGNING_KEY_INVALID");
  const attestationPrivateKey = createPrivateKey(attestationKeyBytes);
  attestationKeyBytes.fill(0);
  if (attestationPrivateKey.asymmetricKeyType !== "ed25519") throw new Error("RUN_ATTESTATION_KEY_INVALID");

  const brokerCall = (input: { path: string; body: Record<string, unknown>; attestation: string }) => new Promise<{
    status: number;
    body: unknown;
  }>((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(input.body), "utf8");
    const options: RequestOptions = {
      protocol: "https:",
      hostname: brokerOrigin.hostname,
      port: brokerOrigin.port ? Number(brokerOrigin.port) : 443,
      method: "POST",
      path: input.path,
      ca: brokerCa,
      cert: brokerCertificate,
      key: brokerKeyBytes,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      servername: brokerOrigin.hostname,
      headers: {
        "content-type": "application/json",
        "content-length": String(encoded.length),
        "seori-run-attestation": input.attestation,
      },
      timeout: 10_000,
    };
    const outgoing = httpsRequest(options, (incoming) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      incoming.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT) outgoing.destroy(new Error("AUTH_BROKER_RESPONSE_LIMIT"));
        else chunks.push(Buffer.from(chunk));
      });
      incoming.on("end", () => {
        const payload = Buffer.concat(chunks);
        try {
          resolve({ status: incoming.statusCode ?? 500, body: JSON.parse(payload.toString("utf8")) });
        } catch {
          resolve({ status: incoming.statusCode ?? 500, body: null });
        } finally {
          payload.fill(0);
          for (const chunk of chunks) chunk.fill(0);
        }
      });
    });
    outgoing.once("timeout", () => outgoing.destroy(new Error("AUTH_BROKER_TIMEOUT")));
    outgoing.once("error", reject);
    let cleared = false;
    const clearEncoded = () => {
      if (cleared) return;
      cleared = true;
      encoded.fill(0);
    };
    outgoing.once("close", clearEncoded);
    outgoing.end(encoded, clearEncoded);
  });

  const server = createServer({
    ca: signerClientCa,
    cert: signerCertificate,
    key: signerKeyBytes,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
  }, async (request, response) => {
    try {
      assertWorkerPeer(request.socket as TLSSocket);
      if (request.method !== "POST" || request.headers["content-type"] !== "application/json") {
        respond(response, 404, { error: { code: "route_not_found" } });
        return;
      }
      if (request.url === "/v1/claims") {
        const body = claimSchema.parse(await readJson(request));
        const result = await claimProviderExecution({
          workerId,
          leaseSeconds: body.leaseSeconds,
          idempotencyKey: body.idempotencyKey,
          signingKey: queueSigningKey,
        });
        respond(response, 200, {
          duplicate: result.duplicate,
          claim: result.claim ? {
            executionId: result.claim.executionId,
            generation: result.claim.generation,
            expiresAt: result.claim.expiresAt.toISOString(),
            resumeMode: result.claim.resumeMode,
            envelope: result.claim.envelope,
          } : null,
        });
        return;
      }
      if (request.url === "/v1/broker-requests") {
        const body = brokerRequestSchema.parse(await readJson(request));
        const now = new Date();
        const nonce = createRunAttestationNonce();
        const authorized = await authorizeProviderBrokerRequest({
          ...body,
          workerId,
          subject,
          nonceDigest: runAttestationNonceDigest(nonce),
          now,
        });
        const attestation = signRunAttestation({
          privateKey: attestationPrivateKey,
          clientSpiffeId: brokerSpiffeId,
          subject,
          runId: authorized.envelope.executionId,
          repository: authorized.envelope.repository,
          workerId,
          issuedAt: now.getTime(),
          expiresAt: authorized.attestationExpiresAt.getTime(),
          nonce,
        });
        let broker;
        try {
          broker = sanitizeProviderBrokerResponse(body.stage, await brokerCall({
            path: authorized.request.path,
            body: authorized.request.body,
            attestation,
          }));
        } catch {
          // 특히 CONSUME는 broker가 처리한 뒤 응답만 유실됐을 수 있다. worker가 같은
          // mutation을 재전송하지 않고 별도 RESULT attestation으로 확인하도록 5xx만 반환한다.
          respond(response, 502, { error: { code: "auth_broker_unavailable" } });
          return;
        }
        respond(response, 200, { broker });
        return;
      }
      if (request.url === "/v1/settlements") {
        const body = settlementSchema.parse(await readJson(request));
        let reauthRequestId: string | undefined;
        if (body.outcome === "HUMAN_REQUIRED") {
          const claim = await currentProviderExecutionClaim({
            executionId: body.executionId,
            generation: body.generation,
            workerId,
          });
          const reauth = await recordReauthRequest({
            repoId: BigInt(claim.envelope.repoId),
            provider: claim.envelope.provider,
            origin: claim.envelope.origin,
            publicAccountId: claim.envelope.credential.publicAccountId,
            capability: claim.envelope.credential.capability,
            gate: "HUMAN_MFA",
            actor: workerId,
            idempotencyKey: `provider-reauth:${body.executionId}:${body.generation}`,
          });
          reauthRequestId = reauth.request.id;
        }
        const leaseToken = providerExecutionLeaseToken({
          signingKey: queueSigningKey,
          executionId: body.executionId,
          generation: body.generation,
          workerId,
        });
        const result = await settleProviderExecution({
          ...body,
          leaseToken,
          workerId,
          ...(reauthRequestId ? { reauthRequestId } : {}),
        });
        respond(response, 200, result);
        return;
      }
      respond(response, 404, { error: { code: "route_not_found" } });
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        respond(response, error.status, { error: { code: error.code } });
      } else if (error instanceof z.ZodError) {
        respond(response, 400, { error: { code: "invalid_request" } });
      } else {
        // Error 원문에는 DB/provider/TLS metadata가 들어갈 수 있어 절대 반사하거나 출력하지 않는다.
        respond(response, 409, { error: { code: "provider_signer_rejected" } });
      }
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[provider-execution-attestation-signer] ready port=${port}`);
  });
  const shutdown = () => server.close(() => {
    signerKeyBytes.fill(0);
    brokerKeyBytes.fill(0);
    queueSigningKey.fill(0);
    void prisma.$disconnect();
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(() => {
  console.error("[provider-execution-attestation-signer] 종료 code=SIGNER_FATAL");
  process.exitCode = 1;
});
