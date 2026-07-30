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
const MAX_RESET_ROWS = 100;
const ACCOUNT_REF = /^[A-Za-z0-9._:-]{1,128}$/;

export const LIZARD_TYCOON_IAP_OPERATIONS = [
  "iap-ledger.recent-purchases",
  "iap-ledger.account-entitlements",
  "iap-ledger.refund-review-queue",
  "iap-ledger.reset-app-store-sandbox",
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
  intent: string;
  params: AppOperationValues;
}

interface ResetSourceRecord {
  platform: string;
  productId: string;
  state: "active" | "pending" | "revoked";
  purchasedAt?: string;
  observedAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

interface ResetOutcome {
  testAccountRef: string;
  transitionedPurchases: number;
  transitionedEntitlements: number;
  remainingActiveEntitlements: string[];
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

export function requireLizardOperationIntent(
  operation: string,
  intent: string,
): void {
  const expected =
    operation === "iap-ledger.reset-app-store-sandbox" ? "mutate" : "read";
  if (intent !== expected) {
    throw new Error(
      `도마뱀 AppOps ${operation}은 ${expected} intent만 허용합니다.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireResetSource(value: unknown): ResetSourceRecord {
  if (!isRecord(value)) {
    throw new Error("IAP entitlement source 형식이 올바르지 않습니다.");
  }
  const platform = value.platform;
  const productId = value.productId;
  const state = value.state;
  const observedAt = value.observedAt;
  const updatedAt = value.updatedAt;
  if (
    typeof platform !== "string" ||
    typeof productId !== "string" ||
    !["active", "pending", "revoked"].includes(String(state)) ||
    typeof observedAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw new Error("IAP entitlement source 필드가 올바르지 않습니다.");
  }
  return value as ResetSourceRecord;
}

export function resetAppStoreSourcesForTest(
  rawSources: unknown,
  resetAt: string,
): {
  sources: Record<string, ResetSourceRecord>;
  changed: boolean;
  active: boolean;
} {
  if (!isRecord(rawSources)) {
    throw new Error("IAP entitlement sources 형식이 올바르지 않습니다.");
  }
  const sources: Record<string, ResetSourceRecord> = {};
  let changed = false;
  for (const [orderKey, rawSource] of Object.entries(rawSources)) {
    const source = requireResetSource(rawSource);
    if (
      source.platform === "app_store" &&
      (source.state === "active" || source.state === "pending")
    ) {
      sources[orderKey] = {
        ...source,
        state: "revoked",
        observedAt: resetAt,
        updatedAt: resetAt,
      };
      changed = true;
    } else {
      sources[orderKey] = { ...source };
    }
  }
  return {
    sources,
    changed,
    active: Object.values(sources).some(
      (source) => source.state === "active",
    ),
  };
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

function resetOutcomeFromMarker(
  value: DocumentData,
  accountRef: string,
): ResetOutcome {
  if (
    value.operation !== "iap-ledger.reset-app-store-sandbox" ||
    value.testAccountRef !== accountRef ||
    !Number.isSafeInteger(value.transitionedPurchases) ||
    !Number.isSafeInteger(value.transitionedEntitlements) ||
    !Array.isArray(value.remainingActiveEntitlements) ||
    value.remainingActiveEntitlements.some(
      (item: unknown) => typeof item !== "string",
    )
  ) {
    throw new Error("기존 Sandbox 초기화 request_id 결과가 일치하지 않습니다.");
  }
  return {
    testAccountRef: accountRef,
    transitionedPurchases: value.transitionedPurchases,
    transitionedEntitlements: value.transitionedEntitlements,
    remainingActiveEntitlements: [
      ...value.remainingActiveEntitlements,
    ].sort(),
  };
}

async function resetAppStoreSandbox(
  db: Firestore,
  input: LizardTycoonOperationInput,
): Promise<Pick<AppOpsResult, "summary" | "data">> {
  requireSandboxEnvironment(input.params);
  const accountRef = requireAccountRef(input.params.test_account_ref);
  const resetRef = db.doc(
    `${SANDBOX_LEDGER_ROOT}/app_ops_resets/${input.requestId}`,
  );
  let outcome: ResetOutcome | undefined;

  await db.runTransaction(async (transaction) => {
    const existingReset = await transaction.get(resetRef);
    if (existingReset.exists) {
      outcome = resetOutcomeFromMarker(existingReset.data() ?? {}, accountRef);
      return;
    }

    const [orders, internalEntitlements, publicEntitlements] =
      await Promise.all([
        transaction.get(
          db
            .collection(`${SANDBOX_LEDGER_ROOT}/processed_orders`)
            .where("uid", "==", accountRef),
        ),
        transaction.get(
          db.collection(
            `${SANDBOX_LEDGER_ROOT}/iap_users/${accountRef}/entitlements`,
          ),
        ),
        transaction.get(
          db.collection(
            `${SANDBOX_LEDGER_ROOT}/users/${accountRef}/entitlements`,
          ),
        ),
      ]);

    if (
      orders.size > MAX_RESET_ROWS ||
      internalEntitlements.size > MAX_RESET_ROWS ||
      publicEntitlements.size > MAX_RESET_ROWS
    ) {
      throw new Error(
        `Sandbox 초기화 대상은 주문·entitlement 각각 ${MAX_RESET_ROWS}건 이하여야 합니다.`,
      );
    }

    const internalIds = new Set(
      internalEntitlements.docs.map((document) => document.id),
    );
    const orphanedActiveProjection = publicEntitlements.docs.find(
      (document) =>
        document.data().active === true && !internalIds.has(document.id),
    );
    if (orphanedActiveProjection) {
      throw new Error(
        `내부 source가 없는 활성 entitlement가 있어 초기화를 중단했습니다: ${orphanedActiveProjection.id}`,
      );
    }

    const resetAt = new Date().toISOString();
    const appStoreOrders = orders.docs.filter((document) => {
      const data = document.data();
      if (data.platform !== "app_store") return false;
      if (!["active", "pending", "revoked"].includes(String(data.state))) {
        throw new Error(
          `알 수 없는 App Store 주문 상태가 있어 초기화를 중단했습니다: ${document.id}`,
        );
      }
      return true;
    });
    const transitionedOrders = appStoreOrders.filter(
      (document) => document.data().state !== "revoked",
    );
    const outboxSnapshots = await Promise.all(
      transitionedOrders.map((document) =>
        transaction.get(
          db.doc(
            `${SANDBOX_LEDGER_ROOT}/iap_completion_outbox/${document.id}`,
          ),
        ),
      ),
    );

    transitionedOrders.forEach((document, index) => {
      transaction.set(
        document.ref,
        {
          state: "revoked",
          observedAt: resetAt,
          updatedAt: resetAt,
          providerCompletion: {
            status: "cancelled_by_sandbox_reset",
            updatedAt: resetAt,
          },
          sandboxReset: {
            requestId: input.requestId,
            resetAt,
          },
        },
        { merge: true },
      );
      const outbox = outboxSnapshots[index];
      if (outbox?.exists) {
        transaction.set(
          outbox.ref,
          {
            status: "dead_letter",
            lastError: "sandbox_test_reset",
            updatedAt: resetAt,
          },
          { merge: true },
        );
      }
    });

    let transitionedEntitlements = 0;
    const remainingActiveEntitlements: string[] = [];
    for (const document of internalEntitlements.docs) {
      const data = document.data();
      if (!isRecord(data.sources)) {
        if (data.active === true) {
          throw new Error(
            `source가 없는 활성 entitlement가 있어 초기화를 중단했습니다: ${document.id}`,
          );
        }
        continue;
      }
      const reset = resetAppStoreSourcesForTest(data.sources, resetAt);
      if (reset.active) {
        remainingActiveEntitlements.push(document.id);
      }
      if (!reset.changed) continue;
      transitionedEntitlements += 1;
      transaction.set(
        document.ref,
        {
          entitlementId: document.id,
          sources: reset.sources,
          active: reset.active,
          updatedAt: resetAt,
        },
        { merge: false },
      );
      transaction.set(
        db.doc(
          `${SANDBOX_LEDGER_ROOT}/users/${accountRef}/entitlements/${document.id}`,
        ),
        {
          entitlementId: document.id,
          active: reset.active,
          updatedAt: resetAt,
        },
        { merge: false },
      );
    }
    remainingActiveEntitlements.sort();

    outcome = {
      testAccountRef: accountRef,
      transitionedPurchases: transitionedOrders.length,
      transitionedEntitlements,
      remainingActiveEntitlements,
    };
    transaction.create(resetRef, {
      operation: "iap-ledger.reset-app-store-sandbox",
      environment: "sandbox",
      platform: "app_store",
      ...outcome,
      createdAt: resetAt,
    });
  });

  if (!outcome) {
    throw new Error("Sandbox 초기화 결과를 확인하지 못했습니다.");
  }
  return {
    summary: `App Store sandbox 구매 ${outcome.transitionedPurchases}건과 entitlement ${outcome.transitionedEntitlements}개를 회수 상태로 전환했습니다.`,
    data: {
      environment: "sandbox",
      platform: "app_store",
      ...outcome,
    },
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
  requireLizardOperationIntent(input.operation, input.intent);
  const db = getFirestore(firebaseApp(credentialJson));
  const result =
    input.operation === "iap-ledger.reset-app-store-sandbox"
      ? await resetAppStoreSandbox(db, input)
      : await executeQuery(db, input);
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
