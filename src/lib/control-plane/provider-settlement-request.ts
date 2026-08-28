import { z } from "zod";

/**
 * signer `/v1/settlements`가 worker에게서 받는 유일한 요청 계약이다.
 *
 * worker는 관측 payload를 넘길 수 없다. valid mTLS identity와 살아 있는 claim을 가진
 * worker라도 provider account/app/source/config/artifact 문자열을 스스로 만들어
 * 외부 gate를 전진시킬 수 없어야 하므로, `observation` 계열 필드는 계약에서 제거하고
 * strict object가 잉여 key 자체를 거부한다. 관측은 signer가 Auth Broker에서 직접 읽는다.
 */
export const providerSignerSettlementRequestSchema = z.object({
  executionId: z.string().min(1).max(191),
  generation: z.number().int().positive(),
  outcome: z.enum([
    "COMMAND_ACCEPTED",
    "OBSERVED",
    "RESULT_UNKNOWN",
    "FAILED",
    "HUMAN_REQUIRED",
    "APPROVAL_REQUIRED",
  ]),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_.:-]{0,127}$/).optional(),
  idempotencyKey: z.string().regex(/^provider-settlement:[A-Za-z0-9._:/-]{1,191}$/),
}).strict().superRefine((value, context) => {
  if ((value.outcome === "FAILED" || value.outcome === "APPROVAL_REQUIRED") && !value.errorCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "error code required" });
  }
});

export type ProviderSignerSettlementRequest = z.infer<typeof providerSignerSettlementRequestSchema>;

/** worker가 관측을 주입하려 한 요청은 파싱 전에 구분해서 거부한다. */
export const WORKER_SUPPLIED_OBSERVATION_KEYS = ["observation", "observationReceipt", "leaseToken"] as const;

export function containsWorkerSuppliedObservation(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return WORKER_SUPPLIED_OBSERVATION_KEYS.some((key) => key in (body as Record<string, unknown>));
}
