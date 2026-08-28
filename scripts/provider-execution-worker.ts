import { hostname } from "node:os";

import { executeProviderAdapterClaim } from "@/lib/control-plane/provider-adapter-client";
import { createProductionProviderExecutionBoundary } from "@/lib/control-plane/provider-execution-boundary-client";

const workerId = process.env.PROVIDER_EXECUTION_WORKER_ID?.trim() || `provider-execution:${hostname()}`;
const subject = process.env.PROVIDER_EXECUTION_SUBJECT?.trim() || "k8s:platform:provider-execution-worker";
const signerOriginInput = process.env.PROVIDER_EXECUTION_SIGNER_ORIGIN?.trim();
if (!signerOriginInput) throw new Error("PROVIDER_EXECUTION_SIGNER_ORIGIN_REQUIRED");
const signerOrigin: string = signerOriginInput;

const pollIntervalMs = Number(process.env.PROVIDER_EXECUTION_POLL_INTERVAL_MS ?? "2000");
if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 60_000) {
  throw new Error("PROVIDER_EXECUTION_POLL_INTERVAL_INVALID");
}
let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { running = false; });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const boundary = await createProductionProviderExecutionBoundary({ workerId, subject, signerOrigin });
  const adapter = boundary.adapter;
  console.log(`[provider-execution-worker] 시작 worker=${workerId}`);
  while (running) {
    const requestId = `provider-claim:${workerId}:${Date.now()}`;
    try {
      const claimed = await boundary.claim({
        leaseSeconds: 120,
        idempotencyKey: requestId,
      });
      if (!claimed.claim) {
        await wait(pollIntervalMs);
        continue;
      }
      const { executionId, generation, resumeMode, envelope } = claimed.claim;
      const result = await executeProviderAdapterClaim(adapter, {
        executionId,
        generation,
        resumeMode,
        envelope,
      });
      const settlementId = `provider-settlement:${executionId}:${generation}`;
      if (result.outcome === "APPROVAL_REQUIRED") {
        await boundary.settle({
          executionId,
          generation,
          outcome: "APPROVAL_REQUIRED",
          errorCode: result.errorCode ?? "PER_RUN_APPROVAL_REQUIRED",
          idempotencyKey: settlementId,
        });
      } else if (result.outcome === "HUMAN_REQUIRED") {
        await boundary.settle({
          executionId,
          generation,
          outcome: "HUMAN_REQUIRED",
          idempotencyKey: settlementId,
        });
      } else if (result.outcome === "COMMAND_ACCEPTED" && envelope.operation === "READBACK") {
        // 관측 payload는 worker가 만들지 않는다. signer가 Auth Broker에서 직접 읽는다.
        await boundary.settle({
          executionId,
          generation,
          outcome: "OBSERVED",
          idempotencyKey: settlementId,
        });
      } else {
        await boundary.settle({
          executionId,
          generation,
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
  });
