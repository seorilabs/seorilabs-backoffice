import { z } from "zod";

const nullableText = z.string().nullable();
const nullableDate = z.string().datetime().nullable();

const purchaseSchema = z
  .object({
    purchaseRef: z.string().min(1),
    testAccountRef: nullableText,
    platform: nullableText,
    productId: nullableText,
    entitlementId: nullableText,
    state: nullableText,
    purchasedAt: nullableDate,
    observedAt: nullableDate,
    updatedAt: nullableDate,
    tombstone: z.boolean(),
  })
  .strict();

const sandboxTesterSchema = z
  .object({
    sandboxTesterId: z.string().min(1),
    accountName: nullableText,
    firstName: nullableText,
    lastName: nullableText,
    territory: nullableText,
  })
  .strict();

const operatorGrantSchema = z
  .object({
    grantRef: z.string().min(1),
    playerRef: nullableText,
    entitlementId: nullableText,
    state: nullableText,
    actorLogin: nullableText,
    reason: nullableText,
    createdAt: nullableDate,
    updatedAt: nullableDate,
    revokedAt: nullableDate,
    revokedBy: nullableText,
    revocationReason: nullableText,
  })
  .strict();

export type LizardPurchase = z.infer<typeof purchaseSchema>;
export type LizardSandboxTester = z.infer<typeof sandboxTesterSchema>;
export type LizardOperatorGrant = z.infer<typeof operatorGrantSchema>;

export const LIZARD_ENTITLEMENTS = [
  { value: "sp_galaxy_gecko", label: "은하 도마뱀붙이" },
  { value: "sp_shootingstar_tokay", label: "별똥별 토케이" },
] as const;

export function parseLizardPurchases(data: unknown): LizardPurchase[] {
  return z
    .object({ purchases: z.array(purchaseSchema) })
    .passthrough()
    .parse(data).purchases;
}

export function parseLizardSandboxTesters(
  data: unknown,
): LizardSandboxTester[] {
  return z
    .object({ testers: z.array(sandboxTesterSchema) })
    .passthrough()
    .parse(data).testers;
}

export function parseLizardOperatorGrants(
  data: unknown,
): LizardOperatorGrant[] {
  return z
    .object({ grants: z.array(operatorGrantSchema) })
    .passthrough()
    .parse(data).grants;
}

export function lizardEntitlementLabel(value: string | null): string {
  return (
    LIZARD_ENTITLEMENTS.find((item) => item.value === value)?.label ??
    value ??
    "알 수 없음"
  );
}
