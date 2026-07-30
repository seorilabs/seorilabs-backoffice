import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import {
  getFirestore,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

import type { AppOpsResult, AppOperationValues } from "@/lib/app-ops/operation";

const PROJECT_ID = "lizard-tycoon";
const FIREBASE_APP_NAME = "backoffice-app-ops-lizard-tycoon";
const SERVICE_ACCOUNT_EMAIL =
  "iap-backoffice-ops@lizard-tycoon.iam.gserviceaccount.com";
const SANDBOX_LEDGER_ROOT = "iap_environments/sandbox";
const MAX_RESULT_ROWS = 20;
const ACCOUNT_REF = /^[A-Za-z0-9._:-]{1,128}$/;

export const LIZARD_TYCOON_IAP_OPERATIONS = [
  "iap-ledger.recent-purchases",
  "iap-ledger.account-entitlements",
  "iap-ledger.refund-review-queue",
] as const;

type LizardTycoonIapOperation =
  (typeof LIZARD_TYCOON_IAP_OPERATIONS)[number];

interface ServiceAccountJson {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface LizardTycoonOperationInput {
  requestId: string;
  operation: string;
  params: AppOperationValues;
}

function parseServiceAccount(raw: string): ServiceAccountJson {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("도마뱀 AppOps 서비스 계정 JSON이 올바르지 않습니다.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("도마뱀 AppOps 서비스 계정 JSON 형식이 올바르지 않습니다.");
  }
  const candidate = value as Partial<ServiceAccountJson>;
  if (
    candidate.project_id !== PROJECT_ID ||
    candidate.client_email !== SERVICE_ACCOUNT_EMAIL ||
    typeof candidate.private_key !== "string" ||
    !candidate.private_key.includes("PRIVATE KEY")
  ) {
    throw new Error("도마뱀 AppOps 서비스 계정 identity가 올바르지 않습니다.");
  }
  return candidate as ServiceAccountJson;
}

export function validateLizardCredentialForTest(raw: string): void {
  parseServiceAccount(raw);
}

function firebaseApp(rawCredential: string): App {
  const existing = getApps().find((app) => app.name === FIREBASE_APP_NAME);
  if (existing) return existing;
  const serviceAccount = parseServiceAccount(rawCredential);
  return initializeApp(
    {
      credential: cert({
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email,
        privateKey: serviceAccount.private_key,
      }),
      projectId: PROJECT_ID,
    },
    FIREBASE_APP_NAME,
  );
}

export function requireSandboxEnvironment(
  params: AppOperationValues,
): "sandbox" {
  if (params.environment !== "sandbox") {
    throw new Error("현재 백오피스 IAP 조회는 sandbox 원장만 허용합니다.");
  }
  return "sandbox";
}

export function parseLimit(value: unknown): number {
  if (value === undefined) return 10;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_RESULT_ROWS) {
    throw new Error(`조회 개수는 1~${MAX_RESULT_ROWS} 정수여야 합니다.`);
  }
  return parsed;
}

export function requireAccountRef(value: unknown): string {
  if (typeof value !== "string" || !ACCOUNT_REF.test(value)) {
    throw new Error("테스트 계정 참조 형식이 올바르지 않습니다.");
  }
  return value;
}

export function sanitizePurchase(
  document: QueryDocumentSnapshot<DocumentData>,
) {
  const data = document.data();
  return {
    testAccountRef: stringOrNull(data.uid),
    platform: stringOrNull(data.platform),
    productId: stringOrNull(data.productId),
    entitlementId: stringOrNull(data.entitlementId),
    state: stringOrNull(data.state),
    purchasedAt: isoOrNull(data.purchasedAt),
    observedAt: isoOrNull(data.observedAt),
    updatedAt: isoOrNull(data.updatedAt),
    tombstone: data.tombstone === true,
  };
}

export function sanitizeEntitlement(
  document: QueryDocumentSnapshot<DocumentData>,
) {
  const data = document.data();
  return {
    entitlementId: document.id,
    active: data.active === true,
    updatedAt: isoOrNull(data.updatedAt),
  };
}

export function sanitizeRefundReview(
  document: QueryDocumentSnapshot<DocumentData>,
) {
  const data = document.data();
  return {
    reviewId: document.id,
    orderId: stringOrNull(data.orderId),
    refundReason: numberOrNull(data.refundReason),
    observedAt: isoOrNull(data.observedAt),
    dueAt: isoOrNull(data.dueAt),
    status: stringOrNull(data.status) ?? "pending",
  };
}

async function executeQuery(
  db: Firestore,
  input: LizardTycoonOperationInput,
): Promise<Pick<AppOpsResult, "summary" | "data">> {
  requireSandboxEnvironment(input.params);
  if (input.operation === "iap-ledger.recent-purchases") {
    const limit = parseLimit(input.params.limit);
    const snapshot = await db
      .collection(`${SANDBOX_LEDGER_ROOT}/processed_orders`)
      .orderBy("updatedAt", "desc")
      .limit(limit)
      .get();
    const purchases = snapshot.docs.map(sanitizePurchase);
    return {
      summary: `sandbox 최근 구매 ${purchases.length}건을 조회했습니다.`,
      data: { environment: "sandbox", count: purchases.length, purchases },
    };
  }

  if (input.operation === "iap-ledger.account-entitlements") {
    const accountRef = requireAccountRef(input.params.test_account_ref);
    const [entitlements, purchases] = await Promise.all([
      db
        .collection(
          `${SANDBOX_LEDGER_ROOT}/users/${accountRef}/entitlements`,
        )
        .get(),
      db
        .collection(`${SANDBOX_LEDGER_ROOT}/processed_orders`)
        .where("uid", "==", accountRef)
        .get(),
    ]);
    const entitlementRows = entitlements.docs.map(sanitizeEntitlement);
    const purchaseRows = purchases.docs
      .map(sanitizePurchase)
      .sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt)),
      );
    return {
      summary: `활성 entitlement ${entitlementRows.filter((row) => row.active).length}개, 구매 ${purchaseRows.length}건을 조회했습니다.`,
      data: {
        environment: "sandbox",
        testAccountRef: accountRef,
        entitlements: entitlementRows,
        purchases: purchaseRows,
      },
    };
  }

  if (input.operation === "iap-ledger.refund-review-queue") {
    const limit = parseLimit(input.params.limit);
    const snapshot = await db
      .collection(`${SANDBOX_LEDGER_ROOT}/pending_refund_reviews`)
      .orderBy("dueAt", "asc")
      .limit(limit)
      .get();
    const reviews = snapshot.docs.map(sanitizeRefundReview);
    return {
      summary: `Google Play 환불 검토 대기 ${reviews.length}건을 조회했습니다.`,
      data: { environment: "sandbox", count: reviews.length, reviews },
    };
  }

  throw new Error("도마뱀 AppOps에서 허용되지 않은 오퍼레이션입니다.");
}

export async function executeLizardTycoonOperation(
  input: LizardTycoonOperationInput,
  credentialJson = process.env.LIZARD_TYCOON_APP_OPS_SA_KEY_JSON ?? "",
): Promise<AppOpsResult> {
  if (
    !LIZARD_TYCOON_IAP_OPERATIONS.includes(
      input.operation as LizardTycoonIapOperation,
    )
  ) {
    throw new Error("도마뱀 AppOps에서 허용되지 않은 오퍼레이션입니다.");
  }
  if (!credentialJson) {
    throw new Error("도마뱀 AppOps 서비스 계정이 설정되지 않았습니다.");
  }
  const result = await executeQuery(
    getFirestore(firebaseApp(credentialJson)),
    input,
  );
  return {
    version: 1,
    requestId: input.requestId,
    operation: input.operation,
    status: "success",
    ...result,
    completedAt: new Date().toISOString(),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    return value.toDate().toISOString();
  }
  return null;
}
