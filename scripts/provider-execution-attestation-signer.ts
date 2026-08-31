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
  buildProviderBrokerRequest,
  providerBrokerRequestDigest,
  providerBrokerStageSchema,
  readTrustedBrokerObservation,
  sanitizeProviderBrokerResponse,
  type BrokerTransport,
  type ProviderBrokerStage,
} from "@/lib/control-plane/provider-adapter-client";
import {
  containsWorkerSuppliedObservation,
  providerSignerSettlementRequestSchema,
} from "@/lib/control-plane/provider-settlement-request";
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
import {
  authBrokerJournalCheckpointAdvanceRequestSchema,
  authBrokerJournalCheckpointGenesisRequestSchema,
  authBrokerJournalCheckpointReadRequestSchema,
} from "@/lib/control-plane/contracts";
import {
  advanceAuthBrokerJournalCheckpoint,
  genesisAuthBrokerJournalCheckpoint,
  readAuthBrokerJournalCheckpoint,
} from "@/lib/control-plane/auth-broker-journal-checkpoint-service";
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
// P2 Auth Broker가 journal checkpoint route를 호출할 때 제시하는 client 인증서의 exact
// SPIFFE URI SAN이다. brokerSpiffeId(위)와는 방향이 반대다 — brokerSpiffeId는 signer가
// broker를 호출할 때 스스로 내세우는 identity이고, 이 값은 broker가 signer를 호출할 때
// signer가 검증하는 identity다.
const authBrokerClientSpiffeId = process.env.AUTH_BROKER_CLIENT_SPIFFE_ID?.trim()
  || "spiffe://seorilabs.local/ns/auth-broker/sa/seori-auth-broker";
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
  // OBSERVATION은 signer만 수행한다. worker가 관측 stage를 proxy로 호출하면
  // 신뢰 관측의 ordinal 예산을 소진시켜 settlement readback을 막을 수 있다.
  stage: providerBrokerStageSchema.exclude(["OBSERVATION"]),
  ordinal: z.literal(1),
  expectedRequestDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

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

/** journal checkpoint route 전용. worker mTLS 검증과 완전히 분리된 exact identity다. */
function assertAuthBrokerPeer(socket: TLSSocket) {
  if (!socket.authorized) throw new Error("AUTH_BROKER_MTLS_REQUIRED");
  const certificate = socket.getPeerCertificate(true);
  if (certificate.subjectaltname !== `URI:${authBrokerClientSpiffeId}`) {
    throw new Error("AUTH_BROKER_SPIFFE_ID_MISMATCH");
  }
}

const AUTH_BROKER_JOURNAL_CHECKPOINT_ROUTE_PREFIX = "/v1/auth-broker/journal-checkpoints/";

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

  /** 모든 broker 호출이 지나는 단일 경계다. 매 요청마다 durable claim 결합과 attestation을 새로 검증한다. */
  const authorizeAndCall = async (input: {
    executionId: string;
    generation: number;
    stage: ProviderBrokerStage;
    ordinal: number;
    expectedRequestDigest: string;
  }) => {
    const now = new Date();
    const nonce = createRunAttestationNonce();
    const authorized = await authorizeProviderBrokerRequest({
      ...input,
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
    return sanitizeProviderBrokerResponse(input.stage, await brokerCall({
      path: authorized.request.path,
      body: authorized.request.body,
      attestation,
    }));
  };

  // signer가 스스로 만든 요청은 digest도 스스로 계산한다. worker 입력이 섞이지 않는다.
  const brokerTransport: BrokerTransport = (brokerRequest) => authorizeAndCall({
    executionId: brokerRequest.executionId,
    generation: brokerRequest.generation,
    stage: brokerRequest.stage,
    ordinal: brokerRequest.ordinal,
    expectedRequestDigest: providerBrokerRequestDigest(brokerRequest),
  });

  /**
   * 같은 (execution, generation, stage, ordinal)의 attestation은 한 번만 발급된다.
   * 재시작이나 settlement 재시도에서도 다음 ordinal로 진행해 신뢰 관측을 다시 읽는다.
   */
  async function readObservation(executionId: string, generation: number) {
    const claim = await currentProviderExecutionClaim({ executionId, generation, workerId });
    if (claim.envelope.operation !== "READBACK") return null;
    for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
      try {
        return await readTrustedBrokerObservation({
          envelope: claim.envelope,
          subject,
          workerId,
          ordinal,
          transport: brokerTransport,
        });
      } catch (error) {
        if (
          error instanceof ControlPlaneError
          && error.code === "PROVIDER_ATTESTATION_ALREADY_ISSUED"
        ) continue;
        throw error;
      }
    }
    return null;
  }

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
      const isAuthBrokerRoute = typeof request.url === "string"
        && request.url.startsWith(AUTH_BROKER_JOURNAL_CHECKPOINT_ROUTE_PREFIX);
      // worker와 broker는 서로 다른 client 인증서를 쓰는 완전히 분리된 peer다. 경로별로
      // 정확히 하나의 identity만 검증하며 둘을 겹쳐 받지 않는다.
      if (isAuthBrokerRoute) {
        assertAuthBrokerPeer(request.socket as TLSSocket);
      } else {
        assertWorkerPeer(request.socket as TLSSocket);
      }
      if (request.method !== "POST" || request.headers["content-type"] !== "application/json") {
        respond(response, 404, { error: { code: "route_not_found" } });
        return;
      }
      if (request.url === "/v1/auth-broker/journal-checkpoints/genesis") {
        const body = authBrokerJournalCheckpointGenesisRequestSchema.parse(await readJson(request));
        const result = await genesisAuthBrokerJournalCheckpoint({
          journalId: body.journalId,
          actor: authBrokerClientSpiffeId,
        });
        respond(response, 200, result);
        return;
      }
      if (request.url === "/v1/auth-broker/journal-checkpoints/read") {
        const body = authBrokerJournalCheckpointReadRequestSchema.parse(await readJson(request));
        const result = await readAuthBrokerJournalCheckpoint({ journalId: body.journalId });
        respond(response, 200, result);
        return;
      }
      if (request.url === "/v1/auth-broker/journal-checkpoints/advance") {
        const body = authBrokerJournalCheckpointAdvanceRequestSchema.parse(await readJson(request));
        const result = await advanceAuthBrokerJournalCheckpoint({
          journalId: body.journalId,
          expectedGeneration: body.expectedGeneration,
          expectedDigest: body.expectedDigest,
          nextDigest: body.nextDigest,
          actor: authBrokerClientSpiffeId,
        });
        respond(response, 200, result);
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
        let broker;
        try {
          broker = await authorizeAndCall(body);
        } catch (error) {
          if (error instanceof ControlPlaneError) throw error;
          // 특히 CONSUME는 broker가 처리한 뒤 응답만 유실됐을 수 있다. worker가 같은
          // mutation을 재전송하지 않고 별도 RESULT attestation으로 확인하도록 5xx만 반환한다.
          respond(response, 502, { error: { code: "auth_broker_unavailable" } });
          return;
        }
        respond(response, 200, { broker });
        return;
      }
      if (request.url === "/v1/settlements") {
        const raw = await readJson(request);
        if (containsWorkerSuppliedObservation(raw)) {
          // valid mTLS identity와 살아 있는 claim이 있어도 worker가 만든 관측은 받지 않는다.
          // 이 경로는 DB에 어떤 write도 하지 않고 끝난다.
          respond(response, 400, { error: { code: "worker_supplied_observation_rejected" } });
          return;
        }
        const body = providerSignerSettlementRequestSchema.parse(raw);
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
        // 관측은 signer가 durable claim에서 재구성한 envelope으로 broker를 직접 읽어 만든다.
        let trusted: Awaited<ReturnType<typeof readObservation>> = null;
        let outcome = body.outcome;
        let errorCode = body.errorCode;
        if (body.outcome === "OBSERVED") {
          trusted = await readObservation(body.executionId, body.generation);
          if (!trusted) {
            // broker가 아직 관측을 내주지 않았다. durable requeue로 넘겨 restart에 안전하게 만든다.
            outcome = "RESULT_UNKNOWN";
            errorCode = "PROVIDER_OBSERVATION_PENDING";
          }
        }
        const leaseToken = providerExecutionLeaseToken({
          signingKey: queueSigningKey,
          executionId: body.executionId,
          generation: body.generation,
          workerId,
        });
        const result = await settleProviderExecution({
          executionId: body.executionId,
          generation: body.generation,
          outcome,
          idempotencyKey: body.idempotencyKey,
          ...(trusted ? { observation: trusted.observation, observationReceipt: trusted.receipt } : {}),
          ...(errorCode ? { errorCode } : {}),
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
