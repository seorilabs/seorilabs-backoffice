import { hostname } from "node:os";
import { readFile } from "node:fs/promises";

import {
  marketReadbackSchema,
  providerReadbackPayloadSchema,
} from "@/lib/control-plane/contracts";
import {
  createProductionProviderAdapter,
} from "@/lib/control-plane/provider-adapter-client";
import {
  claimProviderExecution,
  readProviderExecutionObservation,
  settleProviderExecution,
} from "@/lib/control-plane/provider-execution-service";
import { recordReauthRequest } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

const workerId = process.env.PROVIDER_EXECUTION_WORKER_ID?.trim() || `provider-execution:${hostname()}`;
const subject = process.env.PROVIDER_EXECUTION_SUBJECT?.trim() || "k8s:platform:provider-execution-worker";
const clientSpiffeId = process.env.PROVIDER_EXECUTION_SPIFFE_ID?.trim()
  || "spiffe://seorilabs.local/ns/platform/sa/provider-execution-worker";
const brokerOriginInput = process.env.SEORI_AUTH_BROKER_ORIGIN?.trim();
if (!brokerOriginInput) throw new Error("SEORI_AUTH_BROKER_ORIGIN_REQUIRED");
const brokerOrigin: string = brokerOriginInput;

const pollIntervalMs = Number(process.env.PROVIDER_EXECUTION_POLL_INTERVAL_MS ?? "2000");
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 60_000) {
  throw new Error("PROVIDER_EXECUTION_POLL_INTERVAL_INVALID");
}
const queueSigningKeyPath = "/var/run/seori-provider-execution/queue-lease/signing.key";

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { running = false; });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function currentReadback(executionId: string, generation: number) {
  for (let attempt = 0; attempt < 20 && running; attempt += 1) {
    const observed = await readProviderExecutionObservation(executionId, generation);
    if (observed?.kind === "BLUEPRINT") {
      return {
        kind: "BLUEPRINT" as const,
        observedAt: observed.observedAt,
        payload: providerReadbackPayloadSchema.parse(observed.payload),
      };
    }
    if (observed?.kind === "MARKET") {
      return { kind: "MARKET" as const, payload: marketReadbackSchema.parse(observed.payload) };
    }
    await wait(500);
  }
  return null;
}

async function main() {
  const queueSigningKey = await readFile(queueSigningKeyPath, "utf8");
  if (queueSigningKey.trim().length < 32) throw new Error("PROVIDER_EXECUTION_LEASE_SIGNING_KEY_INVALID");
  const adapter = await createProductionProviderAdapter({ workerId, subject, clientSpiffeId, brokerOrigin });
  console.log(`[provider-execution-worker] 시작 worker=${workerId}`);
  while (running) {
    const requestId = `provider-claim:${workerId}:${Date.now()}`;
    try {
      const claimed = await claimProviderExecution({
        workerId,
        leaseSeconds: 120,
        idempotencyKey: requestId,
        signingKey: queueSigningKey.trim(),
      });
      if (!claimed.claim) {
        await wait(pollIntervalMs);
        continue;
      }
      const { executionId, generation, leaseToken, envelope } = claimed.claim;
      const result = await adapter.execute(envelope);
      const settlementId = `provider-settlement:${executionId}:${generation}`;
      if (result.outcome === "HUMAN_REQUIRED") {
        const reauth = await recordReauthRequest({
          repoId: BigInt(envelope.repoId),
          provider: envelope.provider,
          origin: envelope.origin,
          publicAccountId: envelope.credential.publicAccountId,
          capability: envelope.credential.capability,
          gate: "HUMAN_MFA",
          actor: workerId,
          idempotencyKey: `provider-reauth:${executionId}:${generation}`,
        });
        await settleProviderExecution({
          executionId,
          generation,
          leaseToken,
          workerId,
          outcome: "HUMAN_REQUIRED",
          reauthRequestId: reauth.request.id,
          idempotencyKey: settlementId,
        });
      } else if (result.outcome === "COMMAND_ACCEPTED" && envelope.operation === "READBACK") {
        const observation = await currentReadback(executionId, generation);
        await settleProviderExecution({
          executionId,
          generation,
          leaseToken,
          workerId,
          outcome: observation ? "OBSERVED" : "RESULT_UNKNOWN",
          ...(observation ? { observation } : {}),
          idempotencyKey: settlementId,
        });
      } else {
        await settleProviderExecution({
          executionId,
          generation,
          leaseToken,
          workerId,
          outcome: result.outcome,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          idempotencyKey: settlementId,
        });
      }
      console.log(`[provider-execution-worker] 완료 execution=${executionId} generation=${generation}`);
    } catch {
      // broker/CLI 오류 객체는 request header나 credential metadata를 포함할 수 있어 원문을 출력하지 않는다.
      console.error("[provider-execution-worker] 처리 실패 code=WORKER_ITERATION_FAILED");
      await wait(pollIntervalMs);
    }
  }
}

main()
  .catch(() => {
    console.error("[provider-execution-worker] 종료 code=WORKER_FATAL");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
