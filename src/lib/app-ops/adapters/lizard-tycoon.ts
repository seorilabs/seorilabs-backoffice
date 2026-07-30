import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import {
  getFirestore,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type QueryDocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";

import type { AppOpsResult, AppOperationValues } from "@/lib/app-ops/operation";
import { asc, asArray, type JsonApiResource } from "@/lib/app-store/asc-client";

const PROJECT_ID = "lizard-tycoon";
const FIREBASE_APP_NAME = "backoffice-app-ops-lizard-tycoon";
const SERVICE_ACCOUNT_EMAIL =
  "iap-backoffice-ops@lizard-tycoon.iam.gserviceaccount.com";
const SANDBOX_LEDGER_ROOT = "iap_environments/sandbox";
const MAX_RESULT_ROWS = 20;
const MAX_RESET_ROWS = 100;
const ACCOUNT_REF = /^[A-Za-z0-9._:-]{1,128}$/;
const RESOURCE_REF = /^[A-Za-z0-9-]{1,128}$/;
const ENTITLEMENT_IDS = [
  "sp_galaxy_gecko",
  "sp_shootingstar_tokay",
] as const;

export const LIZARD_TYCOON_IAP_OPERATIONS = [
  "iap-ledger.recent-purchases",
  "iap-ledger.sandbox-testers",
  "iap-ledger.account-entitlements",
  "iap-ledger.refund-review-queue",
  "iap-ledger.reset-app-store-sandbox",
  "iap-ledger.production-grants",
  "iap-ledger.grant-production-entitlement",
  "iap-ledger.revoke-production-entitlement",
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
  actorLogin: string | null;
  reason: string;
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
  sandboxTesterId: string;
  transitionedPurchases: number;
  transitionedEntitlements: number;
  remainingActiveEntitlements: string[];
}

interface OperatorGrantRecord {
  operation: "iap-ledger.grant-production-entitlement";
  requestId: string;
  playerRef: string;
  entitlementId: (typeof ENTITLEMENT_IDS)[number];
  sourceKey: string;
  state: "active" | "revoked";
  actorLogin: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
  revocationRequestId?: string;
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
    throw new Error("Firebase UID 형식이 올바르지 않습니다.");
  }
  return value;
}

export function requireResourceRef(value: unknown, label: string): string {
  if (typeof value !== "string" || !RESOURCE_REF.test(value)) {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

export function requireEntitlementId(
  value: unknown,
): (typeof ENTITLEMENT_IDS)[number] {
  if (
    typeof value !== "string" ||
    !ENTITLEMENT_IDS.includes(value as (typeof ENTITLEMENT_IDS)[number])
  ) {
    throw new Error("허용되지 않은 도마뱀 entitlement입니다.");
  }
  return value as (typeof ENTITLEMENT_IDS)[number];
}

function requireOperatorAudit(input: LizardTycoonOperationInput): {
  actorLogin: string;
  reason: string;
} {
  const actorLogin = input.actorLogin?.trim() ?? "";
  const reason = input.reason.trim();
  if (!actorLogin || actorLogin.length > 100) {
    throw new Error("Production 지급에는 확인 가능한 운영자 계정이 필요합니다.");
  }
  if (!reason || reason.length > 500) {
    throw new Error("Production 지급·회수에는 500자 이하의 변경 사유가 필요합니다.");
  }
  return { actorLogin, reason };
}

export function requireLizardOperationIntent(
  operation: string,
  intent: string,
): void {
  const expected = [
    "iap-ledger.reset-app-store-sandbox",
    "iap-ledger.grant-production-entitlement",
    "iap-ledger.revoke-production-entitlement",
  ].includes(operation)
    ? "mutate"
    : "read";
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

function copyValidatedSources(
  rawSources: unknown,
): Record<string, ResetSourceRecord> {
  if (!isRecord(rawSources)) {
    throw new Error("IAP entitlement sources 형식이 올바르지 않습니다.");
  }
  return Object.fromEntries(
    Object.entries(rawSources).map(([key, value]) => [
      key,
      { ...requireResetSource(value) },
    ]),
  );
}

export function resetAppStoreSourcesForTest(
  rawSources: unknown,
  resetAt: string,
): {
  sources: Record<string, ResetSourceRecord>;
  changed: boolean;
  active: boolean;
} {
  const sources = copyValidatedSources(rawSources);
  let changed = false;
  for (const [orderKey, source] of Object.entries(sources)) {
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
      sources[orderKey] = source;
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

export function addOperatorSourceForTest(
  rawSources: unknown,
  input: {
    sourceKey: string;
    entitlementId: string;
    actorLogin: string;
    reason: string;
    grantRef: string;
    timestamp: string;
  },
): Record<string, ResetSourceRecord> {
  const sources = copyValidatedSources(rawSources);
  sources[input.sourceKey] = {
    platform: "operator",
    productId: `operator:${input.entitlementId}`,
    state: "active",
    observedAt: input.timestamp,
    updatedAt: input.timestamp,
    actorLogin: input.actorLogin,
    reason: input.reason,
    grantRef: input.grantRef,
  };
  return sources;
}

export function revokeOperatorSourceForTest(
  rawSources: unknown,
  input: {
    sourceKey: string;
    actorLogin: string;
    reason: string;
    requestId: string;
    timestamp: string;
  },
): {
  sources: Record<string, ResetSourceRecord>;
  alreadyRevoked: boolean;
  active: boolean;
} {
  const sources = copyValidatedSources(rawSources);
  const source = sources[input.sourceKey];
  if (!source || source.platform !== "operator") {
    throw new Error("대상 운영자 지급 source가 없어 Production 회수를 중단했습니다.");
  }
  const alreadyRevoked = source.state === "revoked";
  sources[input.sourceKey] = {
    ...source,
    state: "revoked",
    observedAt: input.timestamp,
    updatedAt: input.timestamp,
    revokedBy: input.actorLogin,
    revocationReason: input.reason,
    revocationRequestId: input.requestId,
  };
  return {
    sources,
    alreadyRevoked,
    active: Object.values(sources).some(
      (candidate) => candidate.state === "active",
    ),
  };
}

export function sanitizePurchase(
  document: QueryDocumentSnapshot<DocumentData>,
) {
  const data = document.data();
  return {
    purchaseRef: document.id,
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

export function sanitizeSandboxTester(resource: JsonApiResource) {
  const attributes = isRecord(resource.attributes)
    ? resource.attributes
    : {};
  return {
    sandboxTesterId: resource.id,
    accountName: stringOrNull(attributes.acAccountName),
    firstName: stringOrNull(attributes.firstName),
    lastName: stringOrNull(attributes.lastName),
    territory: stringOrNull(attributes.territory),
  };
}

export function appleSandboxResetBody(sandboxTesterId: string) {
  return {
    data: {
      type: "sandboxTestersClearPurchaseHistoryRequest",
      relationships: {
        sandboxTesters: {
          data: [{ id: sandboxTesterId, type: "sandboxTesters" }],
        },
      },
    },
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
  sandboxTesterId: string,
): ResetOutcome {
  if (
    value.operation !== "iap-ledger.reset-app-store-sandbox" ||
    value.status !== "completed" ||
    value.testAccountRef !== accountRef ||
    value.sandboxTesterId !== sandboxTesterId ||
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
    sandboxTesterId,
    transitionedPurchases: value.transitionedPurchases,
    transitionedEntitlements: value.transitionedEntitlements,
    remainingActiveEntitlements: [
      ...value.remainingActiveEntitlements,
    ].sort(),
  };
}

function validateResetMarker(
  value: DocumentData,
  accountRef: string,
  sandboxTesterId: string,
): void {
  if (
    value.operation !== "iap-ledger.reset-app-store-sandbox" ||
    value.testAccountRef !== accountRef ||
    value.sandboxTesterId !== sandboxTesterId
  ) {
    throw new Error("기존 Sandbox 초기화 request_id 입력이 일치하지 않습니다.");
  }
}

async function ensureAppleSandboxHistoryCleared(
  db: Firestore,
  resetRef: DocumentReference<DocumentData>,
  accountRef: string,
  sandboxTesterId: string,
): Promise<void> {
  const existing = await resetRef.get();
  if (existing.exists) {
    const data = existing.data() ?? {};
    validateResetMarker(data, accountRef, sandboxTesterId);
    if (
      data.status === "completed" ||
      typeof data.applePurchaseHistoryClearedAt === "string"
    ) {
      return;
    }
  }

  await asc("/v2/sandboxTestersClearPurchaseHistoryRequest", {
    method: "POST",
    body: JSON.stringify(appleSandboxResetBody(sandboxTesterId)),
  });
  const clearedAt = new Date().toISOString();
  await resetRef.set(
    {
      operation: "iap-ledger.reset-app-store-sandbox",
      status: "apple_history_cleared",
      environment: "sandbox",
      platform: "app_store",
      testAccountRef: accountRef,
      sandboxTesterId,
      applePurchaseHistoryClearedAt: clearedAt,
      updatedAt: clearedAt,
    },
    { merge: true },
  );
}

async function resetAppStoreSandbox(
  db: Firestore,
  input: LizardTycoonOperationInput,
): Promise<Pick<AppOpsResult, "summary" | "data">> {
  requireSandboxEnvironment(input.params);
  const accountRef = requireAccountRef(input.params.test_account_ref);
  const sandboxTesterId = requireResourceRef(
    input.params.sandbox_tester_id,
    "Apple Sandbox 계정",
  );
  const resetRef = db.doc(
    `${SANDBOX_LEDGER_ROOT}/app_ops_resets/${input.requestId}`,
  );
  await ensureAppleSandboxHistoryCleared(
    db,
    resetRef,
    accountRef,
    sandboxTesterId,
  );
  let outcome: ResetOutcome | undefined;

  await db.runTransaction(async (transaction) => {
    const existingReset = await transaction.get(resetRef);
    if (!existingReset.exists) {
      throw new Error("Apple Sandbox 구매내역 초기화 확인 기록이 없습니다.");
    }
    const resetData = existingReset.data() ?? {};
    validateResetMarker(resetData, accountRef, sandboxTesterId);
    if (resetData.status === "completed") {
      outcome = resetOutcomeFromMarker(
        resetData,
        accountRef,
        sandboxTesterId,
      );
      return;
    }
    if (typeof resetData.applePurchaseHistoryClearedAt !== "string") {
      throw new Error("Apple Sandbox 구매내역 초기화가 확인되지 않았습니다.");
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
      sandboxTesterId,
      transitionedPurchases: transitionedOrders.length,
      transitionedEntitlements,
      remainingActiveEntitlements,
    };
    transaction.set(resetRef, {
      operation: "iap-ledger.reset-app-store-sandbox",
      status: "completed",
      environment: "sandbox",
      platform: "app_store",
      ...outcome,
      firebaseLedgerSyncedAt: resetAt,
      updatedAt: resetAt,
    }, { merge: true });
  });

  if (!outcome) {
    throw new Error("Sandbox 초기화 결과를 확인하지 못했습니다.");
  }
  return {
    summary: `Apple Sandbox 계정 구매내역을 초기화하고 Firebase 구매 ${outcome.transitionedPurchases}건과 entitlement ${outcome.transitionedEntitlements}개를 회수했습니다.`,
    data: {
      environment: "sandbox",
      platform: "app_store",
      ...outcome,
    },
  };
}

function sanitizeOperatorGrant(
  document: QueryDocumentSnapshot<DocumentData>,
) {
  const data = document.data();
  return {
    grantRef: document.id,
    playerRef: stringOrNull(data.playerRef),
    entitlementId: stringOrNull(data.entitlementId),
    state: stringOrNull(data.state),
    actorLogin: stringOrNull(data.actorLogin),
    reason: stringOrNull(data.reason),
    createdAt: isoOrNull(data.createdAt),
    updatedAt: isoOrNull(data.updatedAt),
    revokedAt: isoOrNull(data.revokedAt),
    revokedBy: stringOrNull(data.revokedBy),
    revocationReason: stringOrNull(data.revocationReason),
  };
}

function requireOperatorGrant(
  snapshot: DocumentSnapshot<DocumentData>,
): OperatorGrantRecord {
  if (!snapshot.exists) {
    throw new Error("운영자 지급 기록을 찾을 수 없습니다.");
  }
  const data = snapshot.data() ?? {};
  const entitlementId = requireEntitlementId(data.entitlementId);
  if (
    data.operation !== "iap-ledger.grant-production-entitlement" ||
    data.requestId !== snapshot.id ||
    typeof data.playerRef !== "string" ||
    !ACCOUNT_REF.test(data.playerRef) ||
    typeof data.sourceKey !== "string" ||
    typeof data.actorLogin !== "string" ||
    typeof data.reason !== "string" ||
    typeof data.createdAt !== "string" ||
    typeof data.updatedAt !== "string" ||
    !["active", "revoked"].includes(String(data.state))
  ) {
    throw new Error("운영자 지급 기록 형식이 올바르지 않습니다.");
  }
  return {
    ...(data as Omit<OperatorGrantRecord, "entitlementId">),
    entitlementId,
  };
}

function writeProductionEntitlement(
  transaction: Transaction,
  db: Firestore,
  playerRef: string,
  entitlementId: string,
  sources: Record<string, ResetSourceRecord>,
  updatedAt: string,
): string[] {
  const active = Object.values(sources).some(
    (source) => source.state === "active",
  );
  transaction.set(
    db.doc(`iap_users/${playerRef}/entitlements/${entitlementId}`),
    { entitlementId, sources, active, updatedAt },
    { merge: false },
  );
  transaction.set(
    db.doc(`users/${playerRef}/entitlements/${entitlementId}`),
    { entitlementId, active, updatedAt },
    { merge: false },
  );
  return active ? [entitlementId] : [];
}

async function grantProductionEntitlement(
  db: Firestore,
  input: LizardTycoonOperationInput,
): Promise<Pick<AppOpsResult, "summary" | "data">> {
  const { actorLogin, reason } = requireOperatorAudit(input);
  const playerRef = requireAccountRef(input.params.player_ref);
  const entitlementId = requireEntitlementId(input.params.entitlement_id);
  const grantRef = db.doc(`operator_entitlement_grants/${input.requestId}`);
  const sourceKey = `operator:${input.requestId}`;
  let alreadyGranted = false;

  await db.runTransaction(async (transaction) => {
    const existingGrant = await transaction.get(grantRef);
    if (existingGrant.exists) {
      const existing = requireOperatorGrant(existingGrant);
      if (
        existing.playerRef !== playerRef ||
        existing.entitlementId !== entitlementId ||
        existing.actorLogin !== actorLogin ||
        existing.reason !== reason
      ) {
        throw new Error("기존 Production 지급 request_id 입력이 일치하지 않습니다.");
      }
      alreadyGranted = existing.state === "active";
      return;
    }

    const internalRef = db.doc(
      `iap_users/${playerRef}/entitlements/${entitlementId}`,
    );
    const internal = await transaction.get(internalRef);
    const data = internal.data() ?? {};
    if (data.active === true && !isRecord(data.sources)) {
      throw new Error("source가 없는 활성 Production entitlement가 있어 지급을 중단했습니다.");
    }
    const timestamp = new Date().toISOString();
    const sources = addOperatorSourceForTest(
      isRecord(data.sources) ? data.sources : {},
      {
        sourceKey,
        entitlementId,
        actorLogin,
        reason,
        grantRef: input.requestId,
        timestamp,
      },
    );
    writeProductionEntitlement(
      transaction,
      db,
      playerRef,
      entitlementId,
      sources,
      timestamp,
    );
    transaction.create(grantRef, {
      operation: "iap-ledger.grant-production-entitlement",
      requestId: input.requestId,
      playerRef,
      entitlementId,
      sourceKey,
      state: "active",
      actorLogin,
      reason,
      createdAt: timestamp,
      updatedAt: timestamp,
    } satisfies OperatorGrantRecord);
  });

  return {
    summary: alreadyGranted
      ? "동일한 Production 운영자 지급이 이미 적용되어 있습니다."
      : `${playerRef} 계정에 ${entitlementId} 도마뱀을 지급했습니다.`,
    data: {
      environment: "production",
      grantRef: input.requestId,
      playerRef,
      entitlementId,
      state: "active",
      alreadyGranted,
    },
  };
}

async function revokeProductionEntitlement(
  db: Firestore,
  input: LizardTycoonOperationInput,
): Promise<Pick<AppOpsResult, "summary" | "data">> {
  const { actorLogin, reason } = requireOperatorAudit(input);
  const grantId = requireResourceRef(input.params.grant_ref, "지급 기록");
  const grantRef = db.doc(`operator_entitlement_grants/${grantId}`);
  const revocationRef = db.doc(
    `operator_entitlement_revocations/${input.requestId}`,
  );
  let grant: OperatorGrantRecord | undefined;
  let alreadyRevoked = false;
  let entitlementActive = false;

  await db.runTransaction(async (transaction) => {
    const [existingRevocation, grantSnapshot] = await Promise.all([
      transaction.get(revocationRef),
      transaction.get(grantRef),
    ]);
    grant = requireOperatorGrant(grantSnapshot);
    if (existingRevocation.exists) {
      const existing = existingRevocation.data() ?? {};
      if (
        existing.grantRef !== grantId ||
        existing.actorLogin !== actorLogin ||
        existing.reason !== reason
      ) {
        throw new Error("기존 Production 회수 request_id 입력이 일치하지 않습니다.");
      }
      alreadyRevoked = true;
      entitlementActive = existing.entitlementActive === true;
      return;
    }

    const timestamp = new Date().toISOString();
    const internalRef = db.doc(
      `iap_users/${grant.playerRef}/entitlements/${grant.entitlementId}`,
    );
    const internal = await transaction.get(internalRef);
    const data = internal.data() ?? {};
    if (!isRecord(data.sources)) {
      throw new Error("운영자 지급 source가 없어 Production 회수를 중단했습니다.");
    }
    const revoked = revokeOperatorSourceForTest(data.sources, {
      sourceKey: grant.sourceKey,
      actorLogin,
      reason,
      requestId: input.requestId,
      timestamp,
    });
    alreadyRevoked = grant.state === "revoked" || revoked.alreadyRevoked;
    entitlementActive =
      writeProductionEntitlement(
        transaction,
        db,
        grant.playerRef,
        grant.entitlementId,
        revoked.sources,
        timestamp,
      ).length > 0;
    transaction.set(
      grantRef,
      {
        state: "revoked",
        revokedAt: timestamp,
        revokedBy: actorLogin,
        revocationReason: reason,
        revocationRequestId: input.requestId,
        updatedAt: timestamp,
      },
      { merge: true },
    );
    transaction.create(revocationRef, {
      operation: "iap-ledger.revoke-production-entitlement",
      requestId: input.requestId,
      grantRef: grantId,
      playerRef: grant.playerRef,
      entitlementId: grant.entitlementId,
      actorLogin,
      reason,
      entitlementActive,
      createdAt: timestamp,
    });
  });

  if (!grant) {
    throw new Error("Production 회수 결과를 확인하지 못했습니다.");
  }
  return {
    summary: alreadyRevoked
      ? "해당 Production 운영자 지급은 이미 회수되어 있습니다."
      : `${grant.playerRef} 계정의 ${grant.entitlementId} 운영자 지급을 회수했습니다.`,
    data: {
      environment: "production",
      grantRef: grantId,
      playerRef: grant.playerRef,
      entitlementId: grant.entitlementId,
      state: "revoked",
      alreadyRevoked,
      entitlementActive,
    },
  };
}

async function executeQuery(
  db: Firestore,
  input: LizardTycoonOperationInput,
): Promise<Pick<AppOpsResult, "summary" | "data">> {
  if (input.operation === "iap-ledger.recent-purchases") {
    requireSandboxEnvironment(input.params);
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

  if (input.operation === "iap-ledger.sandbox-testers") {
    const response = await asc("/v2/sandboxTesters?limit=200");
    const testers = asArray(response.data).map(sanitizeSandboxTester);
    return {
      summary: `Apple Sandbox 계정 ${testers.length}개를 조회했습니다.`,
      data: { count: testers.length, testers },
    };
  }

  if (input.operation === "iap-ledger.account-entitlements") {
    requireSandboxEnvironment(input.params);
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
    requireSandboxEnvironment(input.params);
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

  if (input.operation === "iap-ledger.production-grants") {
    const limit = parseLimit(input.params.limit);
    const snapshot = await db
      .collection("operator_entitlement_grants")
      .orderBy("updatedAt", "desc")
      .limit(limit)
      .get();
    const grants = snapshot.docs.map(sanitizeOperatorGrant);
    return {
      summary: `Production 운영자 지급 ${grants.length}건을 조회했습니다.`,
      data: {
        environment: "production",
        count: grants.length,
        grants,
      },
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
  let result: Pick<AppOpsResult, "summary" | "data">;
  if (input.operation === "iap-ledger.reset-app-store-sandbox") {
    result = await resetAppStoreSandbox(db, input);
  } else if (input.operation === "iap-ledger.grant-production-entitlement") {
    result = await grantProductionEntitlement(db, input);
  } else if (input.operation === "iap-ledger.revoke-production-entitlement") {
    result = await revokeProductionEntitlement(db, input);
  } else {
    result = await executeQuery(db, input);
  }
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
