import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";
/** 관측 저장과 사람에게 보고할지의 판단은 별개다. 횟수 제한은 두지 않는다. */
export interface ReportDecision {
  send: boolean;
  reason: string;
}
const internalSignals = new Set([
  "review-rating-change",
  "metric-observation",
  "competitor-update",
  "policy-update",
  "source-stale",
  "source-recovery",
  "release-impact",
  "keyword-change", // 발행 스냅샷의 순위 보고서로 통합
  "review-change", // 개수만 가진 기존 요약은 원문 보고와 중복
  "service-failure",
  "service-recovery", // 장애 카드와 중복
  "submission-approved",
  "submission-rejected",
  "published", // 버전·마켓 전환 카드와 중복
]);
export function signalDecision(kind: string): ReportDecision {
  return internalSignals.has(kind)
    ? { send: false, reason: `INTERNAL_OBSERVATION:${kind}` }
    : { send: true, reason: "MATERIAL_CHANGE" };
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function reportDecision(
  input: { kind: string; dedupeKey?: string; payload: unknown },
  paused = false,
): ReportDecision {
  const p = object(input.payload),
    report = object(p.report),
    key = input.dedupeKey ?? "";
  // 승인과 실제 피해 알림은 보고 중지와 무관하게 계속한다.
  const approvalButtons =
    Array.isArray(p.components) &&
    p.components.some(
      (row) =>
        Array.isArray(object(row).components) &&
        (object(row).components as unknown[]).some((button) =>
          /^(approval:|platform-approval:)/.test(
            String(object(button).custom_id ?? ""),
          ),
        ),
    );
  if (
    approvalButtons ||
    typeof p.deploymentApprovalId === "string" ||
    input.kind === "DEPLOY_COMPLETION"
  )
    return { send: true, reason: "RELEASE_DECISION" };
  if (input.kind === "INCIDENT") return { send: true, reason: "USER_IMPACT" };
  if (report.category === "urgent" || report.category === "response")
    return { send: true, reason: "ACTION_REQUIRED" };
  if (report.category === "internal")
    return {
      send: false,
      reason:
        typeof report.reason === "string" ? report.reason : "INTERNAL_RECORD",
    };
  if (typeof p.signalKind === "string") {
    const decision = signalDecision(p.signalKind);
    if (!decision.send) return decision;
  }
  if (
    /^(platform-approval-alert:|ait-console-collection:|console-collection:|console-sync:|metrics:operations:|metrics:daily:|keyword-daily:|iap-row:|iap-daily:|identity-row:|identity-daily:|identity-summary:|stage-nudge:|weekly-liveops:)/.test(
      key,
    ) ||
    ["DAILY_METRICS", "IDENTITY_ROW", "IDENTITY_SUMMARY"].includes(input.kind)
  )
    return { send: false, reason: "REPLACED_BY_CONTEXTUAL_REPORT" };
  if (input.kind === "OPERATIONAL_EVENT" && report.category !== "change")
    return {
      send: false,
      reason: "SUCCESS_EVENT_LEDGER_OR_DUPLICATE_INCIDENT",
    };
  if (paused) return { send: false, reason: "REPORTS_PAUSED" };
  return { send: true, reason: "REPORT_OR_REQUESTED_RESULT" };
}

/** 시각·분석 상태가 달라져도 같은 결론은 같은 지문이다. */
export function reportFingerprint(kind: string, payload: unknown): string {
  const p = object(payload);
  const body = {
    kind,
    approvalId: p.deploymentApprovalId ?? null,
    incidentId: p.incidentId ?? null,
    releaseRecordId: p.releaseRecordId ?? null,
    text: p.text ?? null,
    source: p.source ?? null,
    thread: p.thread ?? null,
    chart: p.chart ?? null,
    embed: p.embed ? { ...object(p.embed), timestamp: null } : null,
    rankReport: p.rankReport ?? null,
    components: p.components ?? null,
    attachment: p.attachment ?? null,
  };
  return createHash("sha256")
    .update(canonicalJson(body as JsonValue))
    .digest("hex");
}
