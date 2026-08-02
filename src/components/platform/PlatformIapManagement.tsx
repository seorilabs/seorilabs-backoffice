"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import {
  closeNotStartedSandboxResetAction,
  enqueuePlatformOperationAction,
  getPlatformOperationStatusAction,
  reconcileExpiredUnknownPlatformOperationAction,
  resumePreparedSandboxResetAction,
  retryUnknownPlatformOperationAction,
  type PlatformOperationKey,
} from "@/lib/actions/platform-ops";
import {
  loadPlatformIapCatalogAction,
  loadPlatformIapSnapshotAction,
  lookupPlatformEntitlementsAction,
  type PlatformIapCatalog,
  type PlatformIapSnapshot,
} from "@/lib/actions/platform-read";
import {
  platformOperationConfirmationText,
  platformRequestIdForSubmission,
  platformSandboxResetCloseConfirmationText,
  platformSandboxResetResumeConfirmationText,
  platformUnknownReconciliationConfirmationText,
  type PlatformUnknownReconciliationResolution,
} from "@/lib/platform/confirmation";
import {
  platformCatalogForApp,
  platformEntitlementAllowedForApp,
} from "@/lib/platform/catalog";
import { PLATFORM_OPERATION_REASONS } from "@/lib/platform/reasons";
import type { PlatformEntitlementSummary } from "@/lib/platform/read-contract";
import {
  canSubmitPlatformRecovery,
  listPlatformRecoveryReferences,
  migrateLegacyPlatformRecoveryReference,
  platformBlockingEnqueueRecoveryPlan,
  platformBlockingRecoveryView,
  platformRecoveryRetryRequest,
  removePlatformRecoveryReference,
  savePlatformRecoveryReference,
  type PlatformBlockingReference,
  type PlatformBlockingRecoveryView,
  type PlatformRecoveryReference,
} from "@/lib/platform/recovery";

import {
  PlatformIapConsole,
  type PlatformIapWriteOperationView,
} from "./PlatformIapConsole";

export interface PlatformWritableApp {
  slug: string;
  displayName: string;
}

interface PlatformIapManagementProps {
  initialSnapshot?: PlatformIapSnapshot | null;
  initialError?: string | null;
  initialBlockingReferences?: readonly PlatformBlockingReference[];
  writableApps: readonly PlatformWritableApp[];
  writeAccessError?: string | null;
}

const STATUS_POLL_COUNT = 40;
const STATUS_POLL_MS = 1_500;
const EMPTY_BLOCKING_REFERENCES: readonly PlatformBlockingReference[] = [];

interface PlatformRetryRequest {
  requestId: string;
  /** 현재 탭에서 같은 payload인지 판정할 때만 쓴다. 저장소에는 남기지 않는다. */
  fingerprint: string | null;
  appSlug: string;
  operation: PlatformOperationKey;
  /** PUID는 브라우저 저장소에 남기지 않는다. 새로고침 복구 시 빈 문자열이다. */
  platformUserId: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function PlatformIapManagement({
  initialSnapshot = null,
  initialError = null,
  initialBlockingReferences = EMPTY_BLOCKING_REFERENCES,
  writableApps,
  writeAccessError = null,
}: PlatformIapManagementProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [error, setError] = useState<string | null>(initialError);
  const [selectedPlatformUserId, setSelectedPlatformUserId] = useState("");
  const [entitlements, setEntitlements] = useState<PlatformEntitlementSummary[]>(
    [],
  );
  const [operation, setOperation] = useState<PlatformOperationKey>(
    "platform.iap.grant-entitlement",
  );
  const [appSlug, setAppSlug] = useState(writableApps[0]?.slug ?? "");
  const [catalog, setCatalog] = useState<PlatformIapCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogPending, setCatalogPending] = useState(false);
  const [catalogRefreshVersion, setCatalogRefreshVersion] = useState(0);
  const [platformUserId, setPlatformUserId] = useState("");
  const [entitlementId, setEntitlementId] = useState("");
  const [grantRequestId, setGrantRequestId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [environmentConfirmed, setEnvironmentConfirmed] = useState(false);
  const [appleClearedConfirmed, setAppleClearedConfirmed] = useState(false);
  const [retryRequest, setRetryRequest] =
    useState<PlatformRetryRequest | null>(null);
  const [serverRowConfirmedMissing, setServerRowConfirmedMissing] =
    useState(false);
  const [reconciliationResolution, setReconciliationResolution] = useState<
    PlatformUnknownReconciliationResolution | ""
  >("");
  const [reconciliationConfirmation, setReconciliationConfirmation] =
    useState("");
  const [sandboxResetRemoteState, setSandboxResetRemoteState] = useState<
    "absent" | "prepared" | "completed" | "closed_not_started" | null
  >(null);
  const [resumeConfirmation, setResumeConfirmation] = useState("");
  const [closeConfirmation, setCloseConfirmation] = useState("");
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [writeOperation, setWriteOperation] =
    useState<PlatformIapWriteOperationView>({ state: "idle" });
  const [refreshPending, startRefresh] = useTransition();
  const [lookupPending, startLookup] = useTransition();
  const [writePending, startWrite] = useTransition();

  const environment = snapshot?.health.environment;
  const activeCatalog = platformCatalogForApp(catalog, appSlug);

  const activateRecoveryReference = useCallback(
    (
      reference: PlatformRecoveryReference,
      summary =
        "이 브라우저에 결과 미확인 request ID가 남아 있습니다. 상태 확인 또는 동일 ID 안전 재실행이 필요합니다.",
      state: PlatformIapWriteOperationView["state"] = "unknown",
    ): void => {
      const recovered: PlatformRetryRequest =
        platformRecoveryRetryRequest(reference);
      setRetryRequest(recovered);
      setServerRowConfirmedMissing(false);
      setReconciliationResolution("");
      setReconciliationConfirmation("");
      setSandboxResetRemoteState(null);
      setResumeConfirmation("");
      setCloseConfirmation("");
      setOperation(recovered.operation);
      setAppSlug(recovered.appSlug);
      setConfirmation("");
      setEnvironmentConfirmed(false);
      setAppleClearedConfirmed(false);
      setWriteOperation({
        state,
        actionLabel: operationLabel(recovered.operation),
        summary,
        requestId: recovered.requestId,
      });
    },
    [],
  );

  const activateBlockingRecoveryView = useCallback(
    (view: PlatformBlockingRecoveryView): void => {
      activateRecoveryReference(
        view.retryRequest,
        view.summary,
        view.writeState,
      );
    },
    [activateRecoveryReference],
  );

  const activateBlockingReference = useCallback(
    (reference: PlatformBlockingReference): void => {
      activateBlockingRecoveryView(platformBlockingRecoveryView(reference));
    },
    [activateBlockingRecoveryView],
  );

  /**
   * 확정된 요청 하나만 지우고 다른 탭의 복구 참조는 다음 작업으로 넘긴다.
   * undefined는 브라우저 저장소 오류라 새 ID를 열면 안 된다는 뜻이다.
   */
  function clearRecoveryReference(
    requestId: string,
  ): PlatformRecoveryReference | null | undefined {
    try {
      removePlatformRecoveryReference(window.localStorage, requestId);
      const next = listPlatformRecoveryReferences(window.localStorage)[0] ?? null;
      setServerRowConfirmedMissing(false);
      if (!next) {
        setRetryRequest(null);
        setReconciliationResolution("");
        setReconciliationConfirmation("");
        setSandboxResetRemoteState(null);
        setResumeConfirmation("");
        setCloseConfirmation("");
      }
      return next;
    } catch {
      return undefined;
    }
  }

  useEffect(() => {
    let localReferences: PlatformRecoveryReference[] = [];
    try {
      migrateLegacyPlatformRecoveryReference(window.localStorage);
      localReferences = listPlatformRecoveryReferences(window.localStorage);
      // 다른 브라우저에서 시작한 server blocker도 비민감 참조만 로컬 복구
      // 목록에 합쳐, 현재 blocker가 끝난 뒤 남은 참조를 순서대로 처리한다.
      for (const reference of initialBlockingReferences) {
        savePlatformRecoveryReference(window.localStorage, reference);
      }
    } catch {
      // 저장소 접근 자체가 차단된 브라우저는 enqueue 직전 검사에서 fail-close한다.
    }
    const serverReference = initialBlockingReferences[0];
    if (serverReference) {
      activateBlockingReference(serverReference);
    } else if (localReferences[0]) {
      activateRecoveryReference(localReferences[0]);
    }
    setRecoveryLoaded(true);
  }, [
    activateBlockingReference,
    activateRecoveryReference,
    initialBlockingReferences,
  ]);

  useEffect(() => {
    if (!recoveryLoaded || !retryRequest) return;
    try {
      // PUID, entitlement, reason, typed confirmation, fingerprint는 저장하지 않는다.
      savePlatformRecoveryReference(window.localStorage, retryRequest);
    } catch {
      // 최초 enqueue 전 동기 저장은 별도로 fail-close한다. 이 effect는 복구 참조를
      // 반복 투영할 뿐이므로 렌더를 깨지 않는다.
    }
  }, [recoveryLoaded, retryRequest]);

  useEffect(() => {
    // 새로고침 뒤 대상 원장이 바뀌면 이전 체크를 재사용하지 않는다.
    setEnvironmentConfirmed(false);
    setAppleClearedConfirmed(false);
  }, [environment]);

  useEffect(() => {
    // Apple 구매내역 삭제 확인은 특정 앱·사용자 조합에만 유효하다.
    setAppleClearedConfirmed(false);
  }, [appSlug, platformUserId]);

  useEffect(() => {
    let cancelled = false;
    setCatalog(null);
    setCatalogError(null);
    setEntitlementId("");
    setConfirmation("");
    if (appSlug === "") {
      setCatalogPending(false);
      return () => {
        cancelled = true;
      };
    }

    setCatalogPending(true);
    void loadPlatformIapCatalogAction(appSlug).then((result) => {
      if (cancelled) return;
      setCatalogPending(false);
      if (!result.ok) {
        setCatalogError(result.error);
        return;
      }
      // action/client도 appId를 검증하지만 화면 상태에서도 다시 결합한다.
      if (result.data.appId !== appSlug) {
        setCatalogError("선택한 앱의 entitlement 카탈로그를 확인하지 못했습니다.");
        return;
      }
      setCatalog(result.data);
    });

    return () => {
      cancelled = true;
    };
  }, [appSlug, catalogRefreshVersion]);

  useEffect(() => {
    if (
      entitlementId !== "" &&
      activeCatalog?.entitlements.includes(entitlementId) !== true
    ) {
      setEntitlementId("");
      setConfirmation("");
    }
  }, [activeCatalog, entitlementId]);

  const expectedConfirmation = useMemo(() => {
    const normalizedPlatformUserId = platformUserId.trim();
    const normalizedEntitlementId = entitlementId.trim();
    const normalizedGrantRequestId = grantRequestId.trim();
    const isSandboxReset =
      operation === "platform.iap.reset-app-store-sandbox";
    if (
      appSlug === "" ||
      normalizedPlatformUserId === "" ||
      (!isSandboxReset && normalizedEntitlementId === "") ||
      (operation === "platform.iap.revoke-entitlement" &&
        normalizedGrantRequestId === "")
    ) {
      return "";
    }
    return platformOperationConfirmationText({
      operation,
      appSlug,
      platformUserId: normalizedPlatformUserId,
      entitlementId: normalizedEntitlementId,
      grantRequestId: normalizedGrantRequestId,
    });
  }, [appSlug, entitlementId, grantRequestId, operation, platformUserId]);

  const submissionFingerprint = useMemo(
    () => {
      const isReset = operation === "platform.iap.reset-app-store-sandbox";
      return JSON.stringify({
        operation,
        appSlug,
        platformUserId: platformUserId.trim(),
        entitlementId: isReset ? null : entitlementId.trim(),
        reason: reason.trim(),
        expectedEnvironment: environment,
        serverConfirmation: confirmation.trim(),
        grantRequestId:
          operation === "platform.iap.revoke-entitlement"
            ? grantRequestId.trim()
            : null,
        appleClearedConfirmed: isReset ? appleClearedConfirmed : null,
      });
    },
    [
      appleClearedConfirmed,
      appSlug,
      confirmation,
      entitlementId,
      environment,
      grantRequestId,
      operation,
      platformUserId,
      reason,
    ],
  );

  const expectedReconciliationConfirmation = useMemo(() => {
    if (!retryRequest || reconciliationResolution === "") return "";
    return platformUnknownReconciliationConfirmationText({
      appSlug: retryRequest.appSlug,
      requestId: retryRequest.requestId,
      resolution: reconciliationResolution,
    });
  }, [reconciliationResolution, retryRequest]);

  const expectedResumeConfirmation = useMemo(() => {
    if (
      !retryRequest ||
      retryRequest.operation !== "platform.iap.reset-app-store-sandbox" ||
      sandboxResetRemoteState !== "prepared"
    ) {
      return "";
    }
    return platformSandboxResetResumeConfirmationText({
      appSlug: retryRequest.appSlug,
      requestId: retryRequest.requestId,
    });
  }, [retryRequest, sandboxResetRemoteState]);

  const expectedCloseConfirmation = useMemo(() => {
    if (
      !retryRequest ||
      retryRequest.operation !== "platform.iap.reset-app-store-sandbox" ||
      sandboxResetRemoteState !== "absent"
    ) {
      return "";
    }
    return platformSandboxResetCloseConfirmationText({
      appSlug: retryRequest.appSlug,
      requestId: retryRequest.requestId,
    });
  }, [retryRequest, sandboxResetRemoteState]);

  function refreshSnapshot() {
    startRefresh(async () => {
      setCatalogRefreshVersion((current) => current + 1);
      const result = await loadPlatformIapSnapshotAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSnapshot(result.data);
      setError(null);
    });
  }

  function lookupEntitlements(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startLookup(async () => {
      const result = await lookupPlatformEntitlementsAction(
        selectedPlatformUserId,
      );
      if (!result.ok) {
        setEntitlements([]);
        setError(result.error);
        return;
      }
      setEntitlements(result.data.entitlements);
      setSelectedPlatformUserId(result.data.platformUserId);
      setPlatformUserId(result.data.platformUserId);
      setError(null);
    });
  }

  async function pollWrite(
    app: string,
    requestId: string,
    submittedOperation: PlatformOperationKey,
    submittedPlatformUserId: string,
    pollCount = STATUS_POLL_COUNT,
  ): Promise<void> {
    let found = false;
    for (let attempt = 0; attempt < pollCount; attempt += 1) {
      if (attempt > 0) await delay(STATUS_POLL_MS);
      const result = await getPlatformOperationStatusAction(app, requestId);
      if (!result.ok) {
        setWriteOperation({
          state: "unknown",
          actionLabel: operationLabel(submittedOperation),
          summary: result.error ?? "실행 상태를 확인하지 못했습니다.",
          requestId,
        });
        return;
      }
      if (!result.found) continue;
      found = true;
      setServerRowConfirmedMissing(false);
      if (result.status !== "completed") continue;

      if (result.outcomeExpired) {
        const resetState = result.sandboxResetState ?? null;
        setSandboxResetRemoteState(resetState);
        setResumeConfirmation("");
        setCloseConfirmation("");
        setReconciliationResolution(
          resetState === "completed"
            ? "applied"
            : resetState === "closed_not_started"
              ? "not_applied"
              : "",
        );
        setReconciliationConfirmation("");
        setWriteOperation({
          state: "expired_unknown",
          actionLabel: operationLabel(submittedOperation),
          summary:
            result.resultError ??
            "동일 request ID 재실행 기한이 지났습니다. 플랫폼 원장과 감사 로그를 수동 대조하기 전에는 새 작업을 만들 수 없습니다.",
          requestId,
        });
        return;
      }

      if (result.outcomeUnknown) {
        setSandboxResetRemoteState(null);
        setResumeConfirmation("");
        setCloseConfirmation("");
        setWriteOperation({
          state: "unknown",
          actionLabel: operationLabel(submittedOperation),
          summary:
            result.result?.summary ??
            "플랫폼 적용 여부를 확정하지 못했습니다. 새 request ID를 만들지 말고 동일 ID로 재실행하세요.",
          requestId,
        });
        return;
      }

      const succeeded = result.conclusion === "success";
      setSandboxResetRemoteState(null);
      setResumeConfirmation("");
      setCloseConfirmation("");
      const terminalSummary = succeeded
        ? result.result?.summary ?? "플랫폼 원장 변경이 완료됐습니다."
        : result.resultError ?? "플랫폼 원장 변경에 실패했습니다.";
      const nextRecovery = clearRecoveryReference(requestId);
      if (nextRecovery === undefined) {
        setRetryRequest((current) =>
          current ? { ...current, fingerprint: null } : current,
        );
        setWriteOperation({
          state: "error",
          actionLabel: operationLabel(submittedOperation),
          summary: `${terminalSummary} 다만 브라우저 복구 참조를 제거하지 못해 새 작업을 차단했습니다. 저장소 접근을 허용한 뒤 상태를 다시 확인하세요.`,
          requestId,
        });
        return;
      }
      setWriteOperation({
        state: succeeded ? "success" : "error",
        actionLabel: operationLabel(submittedOperation),
        summary: terminalSummary,
        requestId,
      });
      setConfirmation("");
      setEnvironmentConfirmed(false);
      setAppleClearedConfirmed(false);
      if (succeeded) {
        const [snapshotResult, entitlementResult] = await Promise.all([
          loadPlatformIapSnapshotAction(),
          submittedPlatformUserId
            ? lookupPlatformEntitlementsAction(submittedPlatformUserId)
            : Promise.resolve(null),
        ]);
        if (snapshotResult.ok) setSnapshot(snapshotResult.data);
        if (entitlementResult?.ok) {
          setSelectedPlatformUserId(entitlementResult.data.platformUserId);
          setEntitlements(entitlementResult.data.entitlements);
        }
      }
      if (nextRecovery) {
        activateRecoveryReference(
          nextRecovery,
          `${terminalSummary} 다른 탭에 남은 결과 미확인 request ID를 이어서 확인해야 합니다.`,
        );
      }
      return;
    }

    setWriteOperation({
      state: "unknown",
      actionLabel: operationLabel(submittedOperation),
      summary: found
        ? "대기 시간이 초과됐습니다. request ID로 작업 상태를 다시 확인하세요."
        : "큐 row를 아직 찾지 못했습니다. 원 요청 값을 다시 입력해도 반드시 보존된 동일 request ID로만 등록됩니다.",
      requestId,
    });
    setServerRowConfirmedMissing(!found);
  }

  function recoverWriteStatus() {
    if (!retryRequest) return;
    startWrite(async () => {
      setWriteOperation({
        state: "submitting",
        actionLabel: operationLabel(retryRequest.operation),
        summary: "보존한 request ID로 worker 상태를 다시 확인합니다.",
        requestId: retryRequest.requestId,
      });
      await pollWrite(
        retryRequest.appSlug,
        retryRequest.requestId,
        retryRequest.operation,
        retryRequest.platformUserId,
      );
    });
  }

  function retryUnknownWrite() {
    if (
      !retryRequest ||
      writeOperation.state !== "unknown" ||
      serverRowConfirmedMissing
    ) {
      return;
    }
    startWrite(async () => {
      setWriteOperation({
        state: "submitting",
        actionLabel: operationLabel(retryRequest.operation),
        summary: "보존한 동일 request ID로 worker 재실행을 요청합니다.",
        requestId: retryRequest.requestId,
      });
      const result = await retryUnknownPlatformOperationAction(
        retryRequest.appSlug,
        retryRequest.requestId,
      );
      if (!result.ok) {
        setWriteOperation({
          state: "unknown",
          actionLabel: operationLabel(retryRequest.operation),
          summary:
            result.error ??
            "동일 request ID 재실행을 등록하지 못했습니다. 상태를 다시 확인하세요.",
          requestId: retryRequest.requestId,
        });
        return;
      }
      await pollWrite(
        retryRequest.appSlug,
        retryRequest.requestId,
        retryRequest.operation,
        retryRequest.platformUserId,
      );
    });
  }

  function resumePreparedSandboxResetWrite() {
    if (
      !retryRequest ||
      retryRequest.operation !== "platform.iap.reset-app-store-sandbox" ||
      writeOperation.state !== "expired_unknown" ||
      sandboxResetRemoteState !== "prepared" ||
      resumeConfirmation !== expectedResumeConfirmation
    ) {
      return;
    }
    startWrite(async () => {
      setWriteOperation({
        state: "submitting",
        actionLabel: operationLabel(retryRequest.operation),
        summary: "prepared reset을 보존된 동일 request ID로 worker에 재등록합니다.",
        requestId: retryRequest.requestId,
      });
      const result = await resumePreparedSandboxResetAction({
        appSlug: retryRequest.appSlug,
        requestId: retryRequest.requestId,
        confirmation: resumeConfirmation,
      });
      if (!result.ok) {
        setWriteOperation({
          state: "expired_unknown",
          actionLabel: operationLabel(retryRequest.operation),
          summary:
            result.error ?? "대기 중인 sandbox reset을 재개하지 못했습니다.",
          requestId: retryRequest.requestId,
        });
        return;
      }
      setResumeConfirmation("");
      setCloseConfirmation("");
      setSandboxResetRemoteState(null);
      await pollWrite(
        retryRequest.appSlug,
        retryRequest.requestId,
        retryRequest.operation,
        retryRequest.platformUserId,
      );
    });
  }

  function closeNotStartedSandboxResetWrite() {
    if (
      !retryRequest ||
      retryRequest.operation !== "platform.iap.reset-app-store-sandbox" ||
      writeOperation.state !== "expired_unknown" ||
      sandboxResetRemoteState !== "absent" ||
      closeConfirmation !== expectedCloseConfirmation
    ) {
      return;
    }
    startWrite(async () => {
      setWriteOperation({
        state: "submitting",
        actionLabel: operationLabel(retryRequest.operation),
        summary:
          "보존된 동일 request ID로 플랫폼의 영구 미시작 종료를 요청합니다.",
        requestId: retryRequest.requestId,
      });
      const result = await closeNotStartedSandboxResetAction({
        appSlug: retryRequest.appSlug,
        requestId: retryRequest.requestId,
        confirmation: closeConfirmation,
      });
      if (!result.ok) {
        setWriteOperation({
          state: "expired_unknown",
          actionLabel: operationLabel(retryRequest.operation),
          summary:
            result.error ?? "sandbox reset 미시작 종료를 등록하지 못했습니다.",
          requestId: retryRequest.requestId,
        });
        return;
      }
      setCloseConfirmation("");
      setSandboxResetRemoteState(null);
      await pollWrite(
        retryRequest.appSlug,
        retryRequest.requestId,
        retryRequest.operation,
        retryRequest.platformUserId,
      );
    });
  }

  function reconcileExpiredUnknownWrite() {
    if (
      !retryRequest ||
      writeOperation.state !== "expired_unknown" ||
      reconciliationResolution === ""
    ) {
      return;
    }
    if (
      retryRequest.operation === "platform.iap.reset-app-store-sandbox" &&
      (sandboxResetRemoteState === "prepared" ||
        sandboxResetRemoteState === "absent" ||
        (sandboxResetRemoteState === "completed" &&
          reconciliationResolution !== "applied") ||
        (sandboxResetRemoteState === "closed_not_started" &&
          reconciliationResolution !== "not_applied") ||
        sandboxResetRemoteState === null)
    ) {
      return;
    }
    const resolution = reconciliationResolution;
    if (
      reconciliationConfirmation !== expectedReconciliationConfirmation
    ) {
      return;
    }

    startWrite(async () => {
      const result = await reconcileExpiredUnknownPlatformOperationAction({
        appSlug: retryRequest.appSlug,
        requestId: retryRequest.requestId,
        resolution,
        confirmation: reconciliationConfirmation,
      });
      if (!result.ok) {
        setWriteOperation({
          state: "expired_unknown",
          actionLabel: operationLabel(retryRequest.operation),
          summary:
            result.error ??
            "결과 미확인 요청을 대조 종료하지 못했습니다.",
          requestId: retryRequest.requestId,
        });
        return;
      }

      const reconciledRequestId = retryRequest.requestId;
      const nextRecovery = clearRecoveryReference(reconciledRequestId);
      if (nextRecovery === undefined) {
        setWriteOperation({
          state: "error",
          actionLabel: operationLabel(retryRequest.operation),
          summary:
            "대조 종료는 기록됐지만 브라우저 복구 참조를 제거하지 못했습니다. 저장소 접근을 허용한 뒤 상태를 다시 확인하세요.",
          requestId: reconciledRequestId,
        });
        return;
      }
      setReconciliationResolution("");
      setReconciliationConfirmation("");
      setWriteOperation({
        state: "success",
        actionLabel: "결과 불명 대조 종료",
        summary:
          resolution === "applied"
            ? "플랫폼 적용 확인 판정을 감사 로그에 기록하고 앱 잠금을 해제했습니다."
            : "플랫폼 미적용 확인 판정을 감사 로그에 기록하고 앱 잠금을 해제했습니다.",
        requestId: reconciledRequestId,
      });
      if (nextRecovery) {
        activateRecoveryReference(
          nextRecovery,
          "현재 대조 종료를 기록했습니다. 다른 탭의 결과 미확인 request ID를 이어서 확인해야 합니다.",
        );
      }
    });
  }

  function submitWrite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (environment !== "sandbox" && environment !== "production") {
      setWriteOperation({
        state: "error",
        summary: "원장 환경을 확인한 뒤 실행하세요.",
      });
      return;
    }
    const targetEnvironment: "sandbox" | "production" = environment;
    const submittedOperation = operation;
    if (
      submittedOperation === "platform.iap.reset-app-store-sandbox" &&
      targetEnvironment !== "sandbox"
    ) {
      setWriteOperation({
        state: "error",
        actionLabel: operationLabel(submittedOperation),
        summary: "App Store 원장 초기화는 sandbox 환경에서만 실행할 수 있습니다.",
      });
      return;
    }
    if (
      submittedOperation === "platform.iap.reset-app-store-sandbox" &&
      !appleClearedConfirmed
    ) {
      setWriteOperation({
        state: "error",
        actionLabel: operationLabel(submittedOperation),
        summary:
          "App Store Connect에서 해당 Sandbox Tester 구매 내역을 먼저 삭제했는지 확인해야 합니다.",
      });
      return;
    }

    startWrite(async () => {
      try {
        migrateLegacyPlatformRecoveryReference(window.localStorage);
        const pendingReferences = listPlatformRecoveryReferences(
          window.localStorage,
        );
        const otherReference = pendingReferences.find(
          (reference) => reference.requestId !== retryRequest?.requestId,
        );
        if (otherReference) {
          activateRecoveryReference(
            otherReference,
            "다른 탭에서 시작한 결과 미확인 request ID가 있어 새 작업을 차단했습니다. 해당 상태부터 확인하세요.",
          );
          return;
        }
      } catch {
        setWriteOperation({
          state: "error",
          actionLabel: operationLabel(submittedOperation),
          summary:
            "브라우저 복구 저장소를 확인할 수 없어 안전을 위해 실행하지 않았습니다.",
        });
        return;
      }
      if (
        retryRequest &&
        !canSubmitPlatformRecovery(retryRequest, serverRowConfirmedMissing)
      ) {
        setWriteOperation({
          state: writeOperation.state,
          actionLabel: operationLabel(retryRequest.operation),
          summary:
            "새로고침으로 원 payload가 제거됐습니다. 먼저 보존된 request ID의 DB 상태를 확인하세요.",
          requestId: retryRequest.requestId,
        });
        return;
      }
      const normalizedGrantRequestId = grantRequestId.trim();
      const fingerprint = submissionFingerprint;
      const wasRecovery = retryRequest !== null;
      // 브라우저와 서버 action 사이의 응답이 유실돼도 같은 요청 ID로
      // 상태를 확인하고 재시도해야 중복 operator source가 생기지 않는다.
      const requestId = platformRequestIdForSubmission(
        fingerprint,
        retryRequest,
        () => crypto.randomUUID(),
      );
      const recoveryRequest: PlatformRetryRequest = {
        requestId,
        fingerprint,
        appSlug,
        operation: submittedOperation,
        platformUserId: platformUserId.trim(),
      };
      try {
        // 서버 action을 호출하기 전에 복구 참조를 동기 저장한다. 탭 crash나
        // 응답 유실 뒤에도 새 requestId로 중복 지급하지 않기 위한 fail-close다.
        savePlatformRecoveryReference(window.localStorage, recoveryRequest);
      } catch {
        setWriteOperation({
          state: "error",
          actionLabel: operationLabel(submittedOperation),
          summary:
            "request ID 복구 정보를 브라우저에 저장할 수 없어 안전을 위해 실행하지 않았습니다.",
          requestId,
        });
        return;
      }
      setServerRowConfirmedMissing(false);
      setRetryRequest(recoveryRequest);
      setWriteOperation({
        state: "submitting",
        actionLabel: operationLabel(submittedOperation),
        summary: "AppOps worker 큐에 요청을 등록하고 있습니다.",
        requestId,
      });
      const common = {
        requestId,
        appSlug,
        platformUserId: platformUserId.trim(),
        reason: reason.trim(),
        serverConfirmation: confirmation.trim(),
      };
      let result: Awaited<
        ReturnType<typeof enqueuePlatformOperationAction>
      >;
      try {
        if (submittedOperation === "platform.iap.grant-entitlement") {
          result = await enqueuePlatformOperationAction({
            operation: submittedOperation,
            ...common,
            entitlementId: entitlementId.trim(),
            expectedEnvironment: targetEnvironment,
          });
        } else if (submittedOperation === "platform.iap.revoke-entitlement") {
          result = await enqueuePlatformOperationAction({
            operation: submittedOperation,
            ...common,
            entitlementId: entitlementId.trim(),
            grantRequestId: normalizedGrantRequestId,
            expectedEnvironment: targetEnvironment,
          });
        } else {
          result = await enqueuePlatformOperationAction({
            operation: submittedOperation,
            ...common,
            expectedEnvironment: "sandbox",
            appleClearedConfirmed: true,
          });
        }
      } catch {
        // enqueue 성공 뒤 응답만 유실됐을 수 있다. 새 요청을 만들지 않고
        // 알고 있는 requestId의 DB 상태부터 확인한다.
        setWriteOperation({
          state: "submitting",
          actionLabel: operationLabel(submittedOperation),
          summary: "등록 응답을 확인하지 못해 동일 request ID의 상태를 조회합니다.",
          requestId,
        });
        await pollWrite(
          appSlug,
          requestId,
          submittedOperation,
          platformUserId.trim(),
        );
        return;
      }
      if (!result.ok || !result.requestId) {
        const existing = await getPlatformOperationStatusAction(appSlug, requestId);
        if (existing.ok && existing.found) {
          await pollWrite(
            appSlug,
            requestId,
            submittedOperation,
            platformUserId.trim(),
          );
          return;
        }
        const blockingRecovery = platformBlockingEnqueueRecoveryPlan(
          recoveryRequest,
          result,
        );
        if (blockingRecovery) {
          try {
            // 방금 만든 미등록 request ID와 서버 blocker를 모두 보존한다.
            // blocker를 먼저 처리한 뒤 원 요청도 같은 ID로 재개한다.
            for (const reference of blockingRecovery.referencesToPreserve) {
              savePlatformRecoveryReference(window.localStorage, reference);
            }
          } catch {
            // 서버 DB 참조가 SoT이므로 저장 실패여도 현재 화면 복구는 계속한다.
          }
          activateBlockingRecoveryView(blockingRecovery.active);
          return;
        }
        if (existing.ok && !existing.found && !wasRecovery) {
          // DB에서 존재하지 않음을 확인했으므로 이 requestId는 실행되지 않았다.
          const nextRecovery = clearRecoveryReference(requestId);
          if (nextRecovery === undefined) {
            setRetryRequest((current) =>
              current ? { ...current, fingerprint: null } : current,
            );
            setWriteOperation({
              state: "error",
              actionLabel: operationLabel(submittedOperation),
              summary:
                "요청은 등록되지 않았지만 브라우저 복구 참조를 제거하지 못했습니다. 저장소 접근을 허용한 뒤 상태를 다시 확인하세요.",
              requestId,
            });
          } else if (nextRecovery) {
            activateRecoveryReference(
              nextRecovery,
              "현재 요청은 등록되지 않았습니다. 다른 탭에 남은 결과 미확인 request ID를 먼저 확인하세요.",
            );
          } else {
            setWriteOperation({
              state: "error",
              actionLabel: operationLabel(submittedOperation),
              summary: result.error ?? "요청을 등록하지 못했습니다.",
              requestId,
            });
          }
        } else if (existing.ok && !existing.found && wasRecovery) {
          setServerRowConfirmedMissing(true);
          // 서버에 row가 없다는 확정 결과 뒤에는 잘못 입력한 값을 고칠 수
          // 있게 탭 메모리 fingerprint만 버린다. request ID는 그대로 보존한다.
          setRetryRequest((current) =>
            current?.requestId === requestId
              ? { ...current, fingerprint: null, platformUserId: "" }
              : current,
          );
          setWriteOperation({
            state: "unknown",
            actionLabel: operationLabel(submittedOperation),
            summary:
              "DB에 이 request ID가 없음을 확인했습니다. 원 요청 값을 다시 입력해 보존된 동일 request ID로 재등록할 수 있습니다.",
            requestId,
          });
        } else {
          setWriteOperation({
            state: "unknown",
            actionLabel: operationLabel(submittedOperation),
            summary:
              "등록 여부를 확인하지 못했습니다. 새 request ID를 만들지 말고 상태를 다시 확인하세요.",
            requestId,
          });
        }
        return;
      }

      setWriteOperation({
        state: "submitting",
        actionLabel: operationLabel(submittedOperation),
        summary: "worker 실행 결과를 확인하고 있습니다.",
        requestId: result.requestId,
      });
      await pollWrite(
        appSlug,
        result.requestId,
        submittedOperation,
        platformUserId.trim(),
      );
    });
  }

  const writeDisabled =
    !recoveryLoaded ||
    writePending ||
    writableApps.length === 0 ||
    expectedConfirmation === "" ||
    confirmation.trim() !== expectedConfirmation ||
    reason.trim() === "" ||
    !environmentConfirmed ||
    (operation === "platform.iap.reset-app-store-sandbox" &&
      (environment !== "sandbox" || !appleClearedConfirmed)) ||
    (operation !== "platform.iap.reset-app-store-sandbox" &&
      !platformEntitlementAllowedForApp(
        catalog,
        appSlug,
        entitlementId.trim(),
      )) ||
    !canSubmitPlatformRecovery(retryRequest, serverRowConfirmedMissing) ||
    writeOperation.state === "expired_unknown" ||
    (retryRequest !== null &&
      (retryRequest.appSlug !== appSlug ||
        retryRequest.operation !== operation ||
        (retryRequest.fingerprint !== null &&
          retryRequest.fingerprint !== submissionFingerprint))) ||
    (environment !== "sandbox" && environment !== "production");

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <form
          onSubmit={lookupEntitlements}
          className="rounded-lg border border-neutral-200 bg-white p-4"
        >
          <h3 className="text-sm font-semibold text-neutral-800">
            사용자 Entitlement 조회
          </h3>
          <p className="mt-1 text-xs text-neutral-500">
            활성·비활성 source를 함께 확인합니다.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={selectedPlatformUserId}
              onChange={(event) => setSelectedPlatformUserId(event.target.value)}
              placeholder="pu_…"
              required
              maxLength={29}
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2 font-mono text-sm outline-none focus:border-neutral-600"
            />
            <button
              type="submit"
              disabled={lookupPending}
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {lookupPending ? "조회 중…" : "조회"}
            </button>
          </div>
        </form>

        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-neutral-800">상태 새로고침</h3>
          <p className="mt-1 text-xs text-neutral-500">
            최근 주문, dead-letter와 운영자 이력을 다시 읽습니다.
          </p>
          <button
            type="button"
            onClick={refreshSnapshot}
            disabled={refreshPending}
            className="mt-3 rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 disabled:opacity-50"
          >
            {refreshPending ? "새로고침 중…" : "플랫폼 상태 새로고침"}
          </button>
        </div>
      </div>

      <form
        onSubmit={submitWrite}
        className="rounded-lg border-2 border-neutral-300 bg-white p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-neutral-900">
              운영자 IAP 원장 변경
            </h3>
            <p className="mt-1 text-xs text-neutral-500">
              요청은 write identity가 분리된 worker에서 실행되며 플랫폼이 앱·사용자·카탈로그·환경을 다시 검증합니다.
            </p>
          </div>
          <span
            className={`rounded-full px-2 py-1 text-xs font-semibold ${
              environment === "production"
                ? "bg-red-100 text-red-700"
                : environment === "sandbox"
                  ? "bg-amber-100 text-amber-800"
                  : "bg-neutral-100 text-neutral-600"
            }`}
          >
            {environment ?? "환경 미확인"}
          </span>
        </div>

        {writableApps.length === 0 ? (
          <div className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {writeAccessError ??
              "변경 권한이 있는 앱이 없습니다. ADMIN 또는 해당 앱 MAINTAINER 소유권이 필요합니다."}
          </div>
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Field label="작업">
              <select
                value={operation}
                onChange={(event) => {
                  setOperation(event.target.value as PlatformOperationKey);
                  setConfirmation("");
                  setAppleClearedConfirmed(false);
                }}
                className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
              >
                <option value="platform.iap.grant-entitlement">지급</option>
                <option value="platform.iap.revoke-entitlement">회수</option>
                <option value="platform.iap.reset-app-store-sandbox">
                  App Store Sandbox 원장 초기화
                </option>
              </select>
            </Field>
            <Field label="앱">
              <select
                value={appSlug}
                onChange={(event) => {
                  setAppSlug(event.target.value);
                  setConfirmation("");
                }}
                className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
              >
                {writableApps.map((app) => (
                  <option key={app.slug} value={app.slug}>
                    {app.displayName} · {app.slug}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="플랫폼 사용자 ID">
              <input
                value={platformUserId}
                onChange={(event) => {
                  setPlatformUserId(event.target.value);
                  setConfirmation("");
                }}
                placeholder="pu_…"
                required
                maxLength={29}
                spellCheck={false}
                className="w-full rounded border border-neutral-300 px-3 py-2 font-mono text-sm"
              />
            </Field>
            {operation !== "platform.iap.reset-app-store-sandbox" && (
              <Field label="Entitlement ID">
                <select
                  value={entitlementId}
                  onChange={(event) => {
                    setEntitlementId(event.target.value);
                    setConfirmation("");
                  }}
                  required
          disabled={
            catalogPending ||
            !activeCatalog ||
            activeCatalog.entitlements.length === 0
          }
                  className="w-full rounded border border-neutral-300 px-3 py-2 font-mono text-sm disabled:bg-neutral-100"
                >
                  <option value="">카탈로그에서 선택</option>
          {activeCatalog?.entitlements.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
        {catalogPending && (
          <span className="mt-1 block text-xs text-neutral-500">
            선택한 앱의 카탈로그를 확인하고 있습니다.
          </span>
        )}
        {catalogError && (
          <span className="mt-1 block text-xs text-red-600">
            {catalogError}
          </span>
        )}
        {activeCatalog && activeCatalog.entitlements.length === 0 && (
                  <span className="mt-1 block text-xs text-red-600">
            이 앱의 카탈로그가 비어 있어 변경할 수 없습니다.
                  </span>
                )}
              </Field>
            )}
            {operation === "platform.iap.revoke-entitlement" && (
              <Field label="원 지급 Request ID">
                <input
                  value={grantRequestId}
                  onChange={(event) => {
                    setGrantRequestId(event.target.value);
                    setConfirmation("");
                  }}
                  placeholder="UUID v4"
                  required
                  maxLength={36}
                  spellCheck={false}
                  className="w-full rounded border border-neutral-300 px-3 py-2 font-mono text-sm"
                />
              </Field>
            )}
            <Field label="변경 사유" wide>
              <select
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
                className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
              >
                <option value="">PII 없는 사유를 선택</option>
                {PLATFORM_OPERATION_REASONS.map(({ code, label }) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-neutral-500">
                이메일·이름·전화번호·영수증·구매 토큰은 감사 원장에 입력하지 않습니다.
              </span>
            </Field>
            {operation === "platform.iap.reset-app-store-sandbox" && (
              <Field label="Apple Sandbox 선행 조치" wide>
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                  먼저 App Store Connect의 Sandbox Tester에서 해당 사용자의 구매 내역을 삭제하세요. 이 작업은 플랫폼 sandbox 원장만 맞추며 Apple 구매 내역은 삭제하지 않습니다.
                </div>
                {environment !== "sandbox" && (
                  <span className="mt-1 block text-xs font-semibold text-red-700">
                    현재 원장이 sandbox가 아니므로 초기화할 수 없습니다.
                  </span>
                )}
                <label className="mt-2 flex items-start gap-2 text-sm text-neutral-700">
                  <input
                    type="checkbox"
                    checked={appleClearedConfirmed}
                    onChange={(event) =>
                      setAppleClearedConfirmed(event.target.checked)
                    }
                    className="mt-0.5"
                  />
                  App Store Connect에서 대상 Sandbox Tester의 구매 내역 삭제를 완료했습니다.
                </label>
              </Field>
            )}
            <Field label="서버 확인 문구" wide>
              <div className="rounded bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100">
                {expectedConfirmation || "대상 값을 먼저 입력하세요."}
              </div>
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder="위 문구를 정확히 입력"
                required
                maxLength={300}
                autoComplete="off"
                spellCheck={false}
                className="mt-2 w-full rounded border border-neutral-300 px-3 py-2 font-mono text-sm"
              />
            </Field>
          </div>
        )}

        <label className="mt-4 flex items-start gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={environmentConfirmed}
            onChange={(event) => setEnvironmentConfirmed(event.target.checked)}
            className="mt-0.5"
          />
          현재 표시된 {environment ?? "미확인"} 원장이 변경 대상임을 확인했습니다.
        </label>
        <button
          type="submit"
          disabled={writeDisabled}
          className={`mt-4 rounded px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 ${
            environment === "production" ? "bg-red-700" : "bg-amber-700"
          }`}
        >
          {writePending
            ? "처리 중…"
            : retryRequest && serverRowConfirmedMissing
              ? "보존된 동일 Request ID로 재등록"
              : retryRequest
                ? "보존된 동일 Request ID로 재요청"
                : `${operationLabel(operation)} 요청`}
        </button>
        {retryRequest && (
          <button
            type="button"
            onClick={recoverWriteStatus}
            disabled={writePending}
            className="ml-2 mt-4 rounded border border-amber-400 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900 disabled:opacity-40"
          >
            동일 Request ID 상태 다시 확인
          </button>
        )}
        {retryRequest &&
          writeOperation.state === "unknown" &&
          !serverRowConfirmedMissing && (
            <button
              type="button"
              onClick={retryUnknownWrite}
              disabled={writePending}
              className="ml-2 mt-4 rounded border border-red-400 bg-red-50 px-4 py-2 text-sm font-semibold text-red-900 disabled:opacity-40"
            >
              동일 Request ID 안전 재실행
            </button>
          )}
        {retryRequest && writeOperation.state === "expired_unknown" && (
          <div className="mt-4 rounded border border-red-300 bg-red-50 p-3">
            <p className="text-sm font-semibold text-red-900">
              {retryRequest.operation ===
                "platform.iap.reset-app-store-sandbox" &&
              sandboxResetRemoteState === "prepared"
                ? "대기 중인 Sandbox Reset 재개"
                : retryRequest.operation ===
                      "platform.iap.reset-app-store-sandbox" &&
                    sandboxResetRemoteState === "absent"
                  ? "Sandbox Reset 미시작 영구 종료"
                : "수동 원장 대조 결과 기록"}
            </p>
            <p className="mt-1 text-xs text-red-800">
              {retryRequest.operation ===
                "platform.iap.reset-app-store-sandbox" &&
              sandboxResetRemoteState === "prepared"
                ? "플랫폼에 durable reset intent가 남아 있습니다. 잠금을 닫거나 새 request ID를 만들 수 없으며, 보존된 동일 request ID로만 재개합니다."
                : retryRequest.operation ===
                      "platform.iap.reset-app-store-sandbox" &&
                    sandboxResetRemoteState === "completed"
                  ? "플랫폼의 immutable completion을 확인했습니다. 플랫폼 적용 확인 판정으로만 잠금을 닫을 수 있습니다."
                  : retryRequest.operation ===
                        "platform.iap.reset-app-store-sandbox" &&
                      sandboxResetRemoteState === "absent"
                    ? "현재 intent가 없지만 곧바로 미적용 판정으로 닫지 않습니다. write worker가 영구 미시작 closure를 먼저 확정해야 새 request ID가 열립니다."
                    : retryRequest.operation ===
                          "platform.iap.reset-app-store-sandbox" &&
                        sandboxResetRemoteState === "closed_not_started"
                      ? "플랫폼의 immutable 미시작 closure를 확인했습니다. 플랫폼 미적용 확인 판정으로만 잠금을 닫을 수 있습니다."
                    : "플랫폼 원장과 감사 로그를 실제로 대조한 뒤 판정을 선택하세요. 이 작업은 IAP 원장을 수정하지 않고 앱 잠금 표식만 감사 기록과 함께 닫습니다."}
            </p>
            {retryRequest.operation ===
              "platform.iap.reset-app-store-sandbox" &&
            sandboxResetRemoteState === "prepared" ? (
              <>
                <div className="mt-3 rounded bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100">
                  {expectedResumeConfirmation}
                </div>
                <input
                  value={resumeConfirmation}
                  onChange={(event) =>
                    setResumeConfirmation(event.target.value)
                  }
                  placeholder="위 재개 문구를 정확히 입력"
                  maxLength={180}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 w-full rounded border border-red-300 bg-white px-3 py-2 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={resumePreparedSandboxResetWrite}
                  disabled={
                    writePending ||
                    resumeConfirmation !== expectedResumeConfirmation
                  }
                  className="mt-3 rounded bg-red-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                >
                  동일 Request ID로 Reset 재개
                </button>
              </>
            ) : retryRequest.operation ===
                "platform.iap.reset-app-store-sandbox" &&
              sandboxResetRemoteState === "absent" ? (
              <>
                <div className="mt-3 rounded bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100">
                  {expectedCloseConfirmation}
                </div>
                <input
                  value={closeConfirmation}
                  onChange={(event) =>
                    setCloseConfirmation(event.target.value)
                  }
                  placeholder="위 미시작 종료 문구를 정확히 입력"
                  maxLength={180}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 w-full rounded border border-red-300 bg-white px-3 py-2 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={closeNotStartedSandboxResetWrite}
                  disabled={
                    writePending ||
                    closeConfirmation !== expectedCloseConfirmation
                  }
                  className="mt-3 rounded bg-red-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                >
                  동일 Request ID를 영구 미시작 종료
                </button>
              </>
            ) : retryRequest.operation !==
                "platform.iap.reset-app-store-sandbox" ||
              sandboxResetRemoteState !== null ? (
              <>
                <select
                  value={reconciliationResolution}
                  onChange={(event) => {
                    setReconciliationResolution(
                      event.target.value as
                        | PlatformUnknownReconciliationResolution
                        | "",
                    );
                    setReconciliationConfirmation("");
                  }}
                  className="mt-3 w-full rounded border border-red-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">대조 결과 선택</option>
                  {(retryRequest.operation !==
                    "platform.iap.reset-app-store-sandbox" ||
                    sandboxResetRemoteState === "completed") && (
                    <option value="applied">플랫폼 적용 확인</option>
                  )}
                  {(retryRequest.operation !==
                    "platform.iap.reset-app-store-sandbox" ||
                    sandboxResetRemoteState === "closed_not_started") && (
                    <option value="not_applied">플랫폼 미적용 확인</option>
                  )}
                </select>
                <div className="mt-3 rounded bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100">
                  {expectedReconciliationConfirmation ||
                    "대조 결과를 먼저 선택하세요."}
                </div>
                <input
                  value={reconciliationConfirmation}
                  onChange={(event) =>
                    setReconciliationConfirmation(event.target.value)
                  }
                  placeholder="위 대조 종료 문구를 정확히 입력"
                  maxLength={180}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 w-full rounded border border-red-300 bg-white px-3 py-2 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={reconcileExpiredUnknownWrite}
                  disabled={
                    writePending ||
                    reconciliationResolution === "" ||
                    reconciliationConfirmation !==
                      expectedReconciliationConfirmation
                  }
                  className="mt-3 rounded bg-red-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                >
                  감사 로그에 판정 기록 후 잠금 해제
                </button>
              </>
            ) : (
              <p className="mt-3 text-xs font-semibold text-red-900">
                플랫폼 durable intent 상태를 확인해야 합니다. 동일 Request ID 상태 다시 확인을 실행하세요.
              </p>
            )}
          </div>
        )}
        {retryRequest && (
          <p className="mt-2 text-xs text-amber-800">
            {writeOperation.state === "expired_unknown"
              ? sandboxResetRemoteState === "prepared"
                ? "prepared reset을 같은 request ID로 완료하기 전에는 잠금을 닫거나 새 request ID를 만들 수 없습니다."
                : sandboxResetRemoteState === "absent"
                  ? "영구 미시작 closure가 성공하기 전에는 잠금을 닫거나 새 request ID를 만들 수 없습니다."
                  : "재실행 기한이 지났습니다. 위 대조 종료 절차 전에는 새 request ID를 만들 수 없습니다."
              : serverRowConfirmedMissing
                ? "DB 미존재를 확인했습니다. 값을 다시 입력해도 보존된 동일 request ID만 사용합니다."
                : "이 요청이 확정되기 전에는 대상 값을 바꾸거나 새 request ID를 만들 수 없습니다."}
          </p>
        )}
      </form>

      <PlatformIapConsole
        environment={environment}
        deadLetterCount={snapshot?.health.deadLetterCount}
        selectedPlatformUserId={selectedPlatformUserId || null}
        orders={snapshot?.orders.map((order) => ({
          ...order,
          market: order.platform,
        }))}
        entitlements={entitlements.map((entitlement) => ({
          ...entitlement,
          sources: entitlement.sources.map((source) => ({
            ...source,
            market: source.platform,
          })),
        }))}
        operatorRecords={snapshot?.operatorRecords}
        writeOperation={writeOperation}
        loading={refreshPending || lookupPending}
        error={error}
      />
    </div>
  );
}

function operationLabel(operation: PlatformOperationKey): string {
  if (operation === "platform.iap.grant-entitlement") {
    return "Entitlement 지급";
  }
  if (operation === "platform.iap.revoke-entitlement") {
    return "Entitlement 회수";
  }
  return "App Store Sandbox 원장 초기화";
}

function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={wide ? "md:col-span-2" : undefined}>
      <span className="mb-1 block text-xs font-medium text-neutral-600">{label}</span>
      {children}
    </label>
  );
}
