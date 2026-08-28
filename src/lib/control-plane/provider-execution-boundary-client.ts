import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { z } from "zod";

import {
  providerCommandEnvelopeSchema,
  providerExecutionObservationSchema,
  type ProviderExecutionObservation,
} from "@/lib/control-plane/contracts";
import {
  SeoriAuthBrokerProviderAdapter,
  providerBrokerRequestDigest,
  type BrokerTransport,
} from "@/lib/control-plane/provider-adapter-client";

const RESPONSE_LIMIT = 64 * 1024;

type SignerTransport = (input: {
  path: "/v1/claims" | "/v1/broker-requests" | "/v1/settlements";
  body: Record<string, unknown>;
}) => Promise<{ status: number; body: unknown }>;

const claimSchema = z.object({
    executionId: z.string().min(1).max(191),
    generation: z.number().int().positive(),
    expiresAt: z.string().datetime(),
    resumeMode: z.enum(["START", "READBACK_FIRST"]),
    envelope: providerCommandEnvelopeSchema,
  }).strict().superRefine((claim, context) => {
    if (
      claim.executionId !== claim.envelope.executionId
      || claim.generation !== claim.envelope.generation
      || claim.resumeMode !== claim.envelope.resumeMode
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "claim binding mismatch" });
    }
  });

const claimResponseSchema = z.object({
  duplicate: z.boolean(),
  claim: claimSchema.nullable(),
}).strict();

const brokerResponseSchema = z.object({
  broker: z.object({
    status: z.number().int().min(100).max(599),
    body: z.unknown(),
  }).strict(),
}).strict();

const settlementResponseSchema = z.object({
  status: z.string().min(1).max(64),
  duplicate: z.boolean(),
}).strict();

export class ProviderExecutionBoundaryClient {
  readonly adapter: SeoriAuthBrokerProviderAdapter;
  readonly #transport: SignerTransport;

  constructor(input: {
    workerId: string;
    subject: string;
    transport: SignerTransport;
  }) {
    this.#transport = input.transport;
    const brokerTransport: BrokerTransport = async (request) => {
      const response = await this.#transport({
        path: "/v1/broker-requests",
        // route/body 자체는 worker가 signer에 주입하지 않는다. signer가 durable RUNNING
        // claim에서 재구성하고 이 digest와 일치할 때만 직접 broker로 proxy한다.
        body: {
          executionId: request.executionId,
          generation: request.generation,
          stage: request.stage,
          ordinal: request.ordinal,
          expectedRequestDigest: providerBrokerRequestDigest(request),
        },
      });
      if (response.status !== 200) return { status: response.status, body: response.body };
      const parsed = brokerResponseSchema.safeParse(response.body);
      if (!parsed.success) {
        return { status: 502, body: { error: { code: "provider_signer_response_invalid" } } };
      }
      return { status: parsed.data.broker.status, body: parsed.data.broker.body ?? null };
    };
    this.adapter = new SeoriAuthBrokerProviderAdapter({
      workerId: input.workerId,
      subject: input.subject,
      transport: brokerTransport,
    });
  }

  async claim(input: { idempotencyKey: string; leaseSeconds: number }) {
    const response = await this.#transport({ path: "/v1/claims", body: input });
    if (response.status !== 200) throw new Error("PROVIDER_SIGNER_CLAIM_REJECTED");
    const parsed = claimResponseSchema.safeParse(response.body);
    if (!parsed.success) throw new Error("PROVIDER_SIGNER_CLAIM_RESPONSE_INVALID");
    return {
      duplicate: parsed.data.duplicate,
      claim: parsed.data.claim ? {
        ...parsed.data.claim,
        expiresAt: new Date(parsed.data.claim.expiresAt),
      } : null,
    };
  }

  async settle(input: {
    executionId: string;
    generation: number;
    outcome: "COMMAND_ACCEPTED" | "OBSERVED" | "RESULT_UNKNOWN" | "FAILED" | "HUMAN_REQUIRED" | "APPROVAL_REQUIRED";
    observation?: ProviderExecutionObservation;
    errorCode?: string;
    idempotencyKey: string;
  }) {
    if (input.observation) providerExecutionObservationSchema.parse(input.observation);
    const response = await this.#transport({ path: "/v1/settlements", body: input as Record<string, unknown> });
    if (response.status !== 200) throw new Error("PROVIDER_SIGNER_SETTLEMENT_REJECTED");
    return settlementResponseSchema.parse(response.body);
  }
}

export async function createProductionProviderExecutionBoundary(input: {
  workerId: string;
  subject: string;
  signerOrigin: string;
}) {
  const origin = new URL(input.signerOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("PROVIDER_SIGNER_ORIGIN_INVALID");
  }
  const fixedRoot = "/var/run/seori-provider-execution/signer-client";
  const [ca, certificate, privateKey] = await Promise.all([
    readFile(`${fixedRoot}/ca.pem`),
    readFile(`${fixedRoot}/tls.crt`),
    readFile(`${fixedRoot}/tls.key`),
  ]);
  const transport: SignerTransport = ({ path, body }) => new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    const request = httpsRequest({
      protocol: "https:",
      hostname: origin.hostname,
      port: origin.port ? Number(origin.port) : 443,
      method: "POST",
      path,
      ca,
      cert: certificate,
      key: privateKey,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      servername: origin.hostname,
      headers: {
        "content-type": "application/json",
        "content-length": String(encoded.length),
      },
      timeout: 10_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT) request.destroy(new Error("PROVIDER_SIGNER_RESPONSE_LIMIT"));
        else chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        const payload = Buffer.concat(chunks);
        try {
          resolve({ status: response.statusCode ?? 500, body: JSON.parse(payload.toString("utf8")) });
        } catch {
          resolve({ status: response.statusCode ?? 500, body: null });
        } finally {
          payload.fill(0);
          for (const chunk of chunks) chunk.fill(0);
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("PROVIDER_SIGNER_TIMEOUT")));
    request.once("error", reject);
    let cleared = false;
    const clearEncoded = () => {
      if (cleared) return;
      cleared = true;
      encoded.fill(0);
    };
    request.once("close", clearEncoded);
    request.end(encoded, clearEncoded);
  });
  return new ProviderExecutionBoundaryClient({ ...input, transport });
}
