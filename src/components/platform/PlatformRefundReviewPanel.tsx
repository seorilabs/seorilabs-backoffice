"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";

import {
  enqueuePlatformOperationAction,
  getPlatformOperationStatusAction,
} from "@/lib/actions/platform-ops";
import { loadPlatformRefundReviewsAction } from "@/lib/actions/platform-read";
import type { PlatformRefundReview } from "@/lib/platform/client";
import {
  PLATFORM_REFUND_REVIEW_PREFERENCES,
  PLATFORM_REFUND_REVIEW_REASONS,
  platformRefundReviewConfirmationText,
  platformRefundReviewPreferenceLabel,
  platformRefundReviewReasonLabel,
  type PlatformRefundReviewDecisionReason,
  type PlatformRefundReviewPreference,
} from "@/lib/platform/refund-review";
import {
  listPlatformRecoveryReferences,
  removePlatformRecoveryReference,
  savePlatformRecoveryReference,
} from "@/lib/platform/recovery";

import type { PlatformWritableApp } from "./PlatformIapManagement";

const POLL_COUNT = 40;
const POLL_MS = 1_500;

interface Props {
  apps: readonly PlatformWritableApp[];
  environment?: string;
  pendingCount?: number;
  dueSoonCount?: number;
  failedCount?: number;
  writeAccessError?: string | null;
  onBusyChange?: (busy: boolean) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function shortReviewId(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ko-KR");
}

function stateLabel(state: PlatformRefundReview["state"]): string {
  switch (state) {
    case "pending":
      return "결정 대기";
    case "decided":
      return "제출 대기";
    case "responded":
      return "Google 응답 완료";
    case "expired":
      return "기한 만료";
    case "failed":
      return "제출 실패";
  }
}

export function PlatformRefundReviewPanel({
  apps,
  environment,
  pendingCount = 0,
  dueSoonCount = 0,
  failedCount = 0,
  writeAccessError = null,
  onBusyChange,
}: Props) {
  const [appSlug, setAppSlug] = useState(apps[0]?.slug ?? "");
  const [reviews, setReviews] = useState<PlatformRefundReview[]>([]);
  const [selected, setSelected] = useState<PlatformRefundReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preference, setPreference] = useState<
    PlatformRefundReviewPreference | ""
  >(
    "",
  );
  const [sampleProvided, setSampleProvided] = useState<"" | "true" | "false">(
    "",
  );
  const [reason, setReason] = useState<
    PlatformRefundReviewDecisionReason | ""
  >(
    "",
  );
  const [evidenceConfirmed, setEvidenceConfirmed] = useState(false);
  const [environmentConfirmed, setEnvironmentConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  const load = useCallback(async () => {
    if (!appSlug) return;
    setLoading(true);
    const result = await loadPlatformRefundReviewsAction(appSlug);
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      setReviews([]);
      return;
    }
    if (result.data.appId !== appSlug) {
      setError("환불 검토 queue의 앱 대상이 일치하지 않습니다.");
      setReviews([]);
      return;
    }
    setError(null);
    setReviews(result.data.refundReviews);
    setSelected((current) =>
      current
        ? result.data.refundReviews.find(
            (review) => review.reviewId === current.reviewId,
          ) ?? null
        : null,
    );
  }, [appSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSelected(null);
    setPreference("");
    setSampleProvided("");
    setReason("");
    setEvidenceConfirmed(false);
    setEnvironmentConfirmed(false);
    setConfirmation("");
    setMessage(null);
  }, [appSlug]);

  const expectedConfirmation = useMemo(() => {
    if (!selected || preference === "") return "";
    return platformRefundReviewConfirmationText({
      appSlug,
      reviewId: selected.reviewId,
      refundPreference: preference,
    });
  }, [appSlug, preference, selected]);

  async function poll(requestId: string): Promise<void> {
    for (let attempt = 0; attempt < POLL_COUNT; attempt += 1) {
      if (attempt > 0) await delay(POLL_MS);
      const status = await getPlatformOperationStatusAction(appSlug, requestId);
      if (!status.ok) {
        setMessage(
          `결과를 확인하지 못했습니다. request ID ${requestId}를 보존했습니다.`,
        );
        return;
      }
      if (!status.found || status.status !== "completed") continue;
      if (status.outcomeUnknown || status.outcomeExpired) {
        setMessage(
          `원격 결과가 불명확합니다. 새 ID를 만들지 말고 ${requestId}로 복구하세요.`,
        );
        return;
      }
      try {
        removePlatformRecoveryReference(window.localStorage, requestId);
      } catch {
        setMessage(
          `처리는 끝났지만 복구 참조를 지우지 못했습니다. request ID ${requestId} 상태를 다시 확인하세요.`,
        );
        return;
      }
      if (status.conclusion === "success") {
        setMessage(status.result?.summary ?? "환불 검토 결정을 확정했습니다.");
        setSelected(null);
        setPreference("");
        setSampleProvided("");
        setReason("");
        setEvidenceConfirmed(false);
        setEnvironmentConfirmed(false);
        setConfirmation("");
        await load();
      } else {
        setMessage(status.resultError ?? "환불 검토 결정 실행에 실패했습니다.");
      }
      onBusyChange?.(false);
      return;
    }
    setMessage(
      `worker 대기 시간이 초과됐습니다. request ID ${requestId}를 보존했습니다.`,
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !selected ||
      selected.state !== "pending" ||
      preference === "" ||
      sampleProvided === "" ||
      reason === "" ||
      (environment !== "sandbox" && environment !== "production") ||
      selected.expectedEnvironment !== environment ||
      !evidenceConfirmed ||
      !environmentConfirmed ||
      confirmation !== expectedConfirmation
    ) {
      setMessage("근거·환경·결정 값과 확인 문구를 모두 확인하세요.");
      return;
    }

    setSubmitting(true);
    onBusyChange?.(true);
    setMessage(null);
    let requestId = "";
    try {
      const existing = listPlatformRecoveryReferences(window.localStorage);
      if (existing.length > 0) {
        setMessage(
          `먼저 보존된 request ID ${existing[0]?.requestId ?? ""} 상태를 확인하세요.`,
        );
        onBusyChange?.(false);
        return;
      }
      requestId = crypto.randomUUID();
      savePlatformRecoveryReference(window.localStorage, {
        requestId,
        appSlug,
        operation: "platform.iap.decide-refund-review",
      });
      const result = await enqueuePlatformOperationAction({
        operation: "platform.iap.decide-refund-review",
        requestId,
        appSlug,
        reviewId: selected.reviewId,
        expectedEnvironment: environment,
        refundPreference: preference,
        sampleContentProvided: sampleProvided === "true",
        reason,
        serverConfirmation: confirmation,
      });
      if (!result.ok || result.requestId !== requestId) {
        if (result.blockingReference) {
          // enqueue transaction이 blocker를 반환했으므로 방금 만든 ID의 row는
          // 존재하지 않는다. 민감 payload를 저장하지 않는 환불 결정은 이 ID를
          // 복구할 수 없으므로 제거하고 실제 서버 blocker만 보존한다.
          removePlatformRecoveryReference(window.localStorage, requestId);
          savePlatformRecoveryReference(
            window.localStorage,
            result.blockingReference,
          );
        }
        const status = await getPlatformOperationStatusAction(appSlug, requestId);
        if (status.ok && !status.found && !result.blockingReference) {
          removePlatformRecoveryReference(window.localStorage, requestId);
          setMessage(result.error ?? "환불 검토 요청을 등록하지 못했습니다.");
          onBusyChange?.(false);
          return;
        }
        setMessage(
          result.error ??
            `등록 결과가 불명확합니다. request ID ${requestId}를 보존했습니다.`,
        );
        return;
      }
      setMessage(`worker 처리 중 · request ID ${requestId}`);
      await poll(requestId);
    } catch {
      setMessage(
        requestId
          ? `등록 결과를 확인하지 못했습니다. request ID ${requestId}를 보존했습니다.`
          : "브라우저 복구 저장소를 사용할 수 없어 실행하지 않았습니다.",
      );
      if (!requestId) onBusyChange?.(false);
    } finally {
      setSubmitting(false);
    }
  }

  const decisionDisabled =
    submitting ||
    !selected ||
    selected.state !== "pending" ||
    preference === "" ||
    sampleProvided === "" ||
    reason === "" ||
    !evidenceConfirmed ||
    !environmentConfirmed ||
    confirmation !== expectedConfirmation ||
    selected.expectedEnvironment !== environment;

  return (
    <section className="rounded-lg border-2 border-red-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900">
            Google Play 환불 검토
          </h3>
          <p className="mt-1 text-xs text-neutral-500">
            token·order ID 없이 실시간 queue를 조회합니다. Google은 첫 결정을 사용하므로 제출 후 변경할 수 없습니다.
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="rounded bg-amber-100 px-2 py-1 text-amber-900">
            미응답 {pendingCount}
          </span>
          <span className="rounded bg-red-100 px-2 py-1 text-red-800">
            1시간 이내 {dueSoonCount}
          </span>
          <span className="rounded bg-neutral-200 px-2 py-1 text-neutral-800">
            실패 {failedCount}
          </span>
        </div>
      </div>

      {apps.length === 0 ? (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {writeAccessError ?? "환불 검토 권한이 있는 앱이 없습니다."}
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            <select
              value={appSlug}
              onChange={(event) => setAppSlug(event.target.value)}
              disabled={submitting}
              className="rounded border border-neutral-300 px-3 py-2 text-sm"
            >
              {apps.map((app) => (
                <option key={app.slug} value={app.slug}>
                  {app.displayName} · {app.slug}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading || submitting}
              className="rounded border border-neutral-300 px-3 py-2 text-sm disabled:opacity-50"
            >
              {loading ? "조회 중…" : "Queue 새로고침"}
            </button>
          </div>

          {error && (
            <p className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </p>
          )}
          {message && (
            <p className="mt-3 rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
              {message}
            </p>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs text-neutral-500">
                <tr>
                  <th className="px-2 py-2">검토 ID</th>
                  <th className="px-2 py-2">상태</th>
                  <th className="px-2 py-2">Google 사유</th>
                  <th className="px-2 py-2">마감</th>
                  <th className="px-2 py-2">결정</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {reviews.map((review) => (
                  <tr key={review.reviewId}>
                    <td className="px-2 py-2 font-mono text-xs" title={review.reviewId}>
                      {shortReviewId(review.reviewId)}
                    </td>
                    <td className="px-2 py-2">{stateLabel(review.state)}</td>
                    <td className="px-2 py-2">#{review.refundReason}</td>
                    <td className="px-2 py-2">{formatDate(review.dueAt)}</td>
                    <td className="px-2 py-2">
                      {review.state === "pending" ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSelected(review);
                            setPreference("");
                            setSampleProvided("");
                            setReason("");
                            setEvidenceConfirmed(false);
                            setEnvironmentConfirmed(false);
                            setConfirmation("");
                          }}
                          disabled={submitting || new Date(review.dueAt) <= new Date()}
                          className="rounded bg-red-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                        >
                          결정 준비
                        </button>
                      ) : (
                        review.refundPreference ?? "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && reviews.length === 0 && (
              <p className="py-6 text-center text-sm text-neutral-500">
                환불 검토 항목이 없습니다.
              </p>
            )}
          </div>
        </>
      )}

      {selected && (
        <form onSubmit={submit} className="mt-5 rounded border border-red-200 bg-red-50 p-4">
          <h4 className="text-sm font-semibold text-red-950">
            변경 불가 결정 · {shortReviewId(selected.reviewId)}
          </h4>
          <p className="mt-1 text-xs text-red-800">
            수신 {formatDate(selected.receivedAt)} · 마감 {formatDate(selected.dueAt)} · 원장 {selected.expectedEnvironment}
          </p>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label>
              <span className="mb-1 block text-xs font-medium text-neutral-700">1. Google 제안</span>
              <select
                value={preference}
                onChange={(event) => {
                  setPreference(
                    event.target.value as PlatformRefundReviewPreference | "",
                  );
                  setConfirmation("");
                }}
                required
                className="w-full rounded border border-red-200 bg-white px-3 py-2 text-sm"
              >
                <option value="">명시적으로 선택</option>
                {PLATFORM_REFUND_REVIEW_PREFERENCES.map((value) => (
                  <option key={value} value={value}>
                    {platformRefundReviewPreferenceLabel(value)} · {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-xs font-medium text-neutral-700">2. 샘플 콘텐츠 제공</span>
              <select
                value={sampleProvided}
                onChange={(event) =>
                  setSampleProvided(event.target.value as "" | "true" | "false")
                }
                required
                className="w-full rounded border border-red-200 bg-white px-3 py-2 text-sm"
              >
                <option value="">기본값 없이 선택</option>
                <option value="true">제공함</option>
                <option value="false">제공하지 않음</option>
              </select>
            </label>
            <label className="md:col-span-2">
              <span className="mb-1 block text-xs font-medium text-neutral-700">고정 감사 사유</span>
              <select
                value={reason}
                onChange={(event) =>
                  setReason(
                    event.target.value as PlatformRefundReviewDecisionReason | "",
                  )
                }
                required
                className="w-full rounded border border-red-200 bg-white px-3 py-2 text-sm"
              >
                <option value="">PII 없는 사유 선택</option>
                {PLATFORM_REFUND_REVIEW_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {platformRefundReviewReasonLabel(value)} · {value}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-3 flex items-start gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              checked={evidenceConfirmed}
              onChange={(event) => setEvidenceConfirmed(event.target.checked)}
              className="mt-0.5"
            />
            별도 이행·CS 근거를 확인했으며 자유 서술, PII, 영수증, token을 입력하지 않았습니다.
          </label>
          <label className="mt-2 flex items-start gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              checked={environmentConfirmed}
              onChange={(event) => setEnvironmentConfirmed(event.target.checked)}
              className="mt-0.5"
            />
            현재 {environment ?? "미확인"} 원장과 대상 review 환경이 일치함을 확인했습니다.
          </label>

          <div className="mt-4 rounded bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100 break-all">
            {expectedConfirmation || "제안을 먼저 선택하세요."}
          </div>
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder="3. 위 문구를 정확히 입력"
            maxLength={512}
            autoComplete="off"
            spellCheck={false}
            className="mt-2 w-full rounded border border-red-200 bg-white px-3 py-2 font-mono text-sm"
          />

          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={decisionDisabled}
              className="rounded bg-red-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {submitting ? "결정 처리 중…" : "변경 불가 결정 확정"}
            </button>
            <button
              type="button"
              onClick={() => setSelected(null)}
              disabled={submitting}
              className="rounded border border-red-300 px-4 py-2 text-sm text-red-900 disabled:opacity-40"
            >
              취소
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
