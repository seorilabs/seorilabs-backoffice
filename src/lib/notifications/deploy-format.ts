import type { ReleaseMarket, ReleaseStatus } from "@prisma/client";
import type { DiscordActionRow } from "@/lib/notifications/discord";

const MARKET_LABEL: Record<ReleaseMarket, string> = {
  AIT: "AppsInToss",
  PLAY: "Google Play",
  APPSTORE: "App Store",
  WEB: "Web",
};

export interface DeployCompletionPayload {
  releaseRecordId: string;
  status: ReleaseStatus;
  runUrl?: string;
}

export interface EnqueueDeployCompletionPayload extends DeployCompletionPayload {
  eventKey: string;
}

export function deployNotificationDedupeKey(releaseRecordId: string, eventKey: string): string {
  if (!/^[a-z0-9]{20,40}$/i.test(releaseRecordId)) throw new Error("잘못된 releaseRecordId");
  if (!/^[a-z0-9:_-]{1,120}$/i.test(eventKey)) throw new Error("잘못된 배포 eventKey");
  return `deploy:${releaseRecordId}:${eventKey}`;
}

export function deployCompletionPayload(value: unknown): DeployCompletionPayload | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const releaseRecordId = String((value as { releaseRecordId?: unknown }).releaseRecordId ?? "");
  const runUrlRaw = (value as { runUrl?: unknown }).runUrl;
  const runUrl = typeof runUrlRaw === "string" && /^https:\/\//.test(runUrlRaw)
    ? runUrlRaw
    : undefined;
  const status = String((value as { status?: unknown }).status ?? "") as ReleaseStatus;
  if (!/^[a-z0-9]{20,40}$/i.test(releaseRecordId)) return null;
  if (!["PENDING", "IN_PROGRESS", "SUCCEEDED", "FAILED", "ROLLED_BACK"].includes(status)) {
    return null;
  }
  return { releaseRecordId, status, runUrl };
}

const WORKFLOW_STATUS_LABEL: Record<ReleaseStatus, string> = {
  PENDING: "☑️ 요청됨",
  IN_PROGRESS: "⏳ 진행 중",
  SUCCEEDED: "✅ 업로드 경로 성공",
  FAILED: "❌ 실패",
  ROLLED_BACK: "↩️ 롤백됨",
};

const REMAINING_GATES: Record<ReleaseMarket, string[]> = {
  PLAY: ["Play 처리: ⚪ 미확인", "내부 테스터 설치 QA: ⚪ 미확인", "프로덕션 승격·심사: ⚪ 미실행", "승인: ⚪ 미확인", "공개 배포: ⚪ 미실행"],
  APPSTORE: ["App Store 처리: ⚪ 미확인", "TestFlight 설치 QA: ⚪ 미확인", "심사 제출: ⚪ 미실행", "승인: ⚪ 미확인", "공개 배포: ⚪ 미실행"],
  AIT: ["AppsInToss 처리: ⚪ 미확인", "샌드박스 설치 QA: ⚪ 미확인", "검수 제출: ⚪ 미실행", "승인: ⚪ 미확인", "공개 배포: ⚪ 미실행"],
  WEB: ["배포 반영: ⚪ 미확인", "live smoke: ⚪ 미실행"],
};

function formatKst(at: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(at);
}

/**
 * deploy-all 실행 결과 카드. 마켓별 잡은 재사용 워크플로라 자체 workflow_run 이 없어
 * ReleaseRecord 가 파생되지 않으므로, 마켓 게이트 대신 실행 단위 결과만 남긴다.
 */
export function buildDeployAllStatusCardText(input: {
  displayName: string;
  version: string;
  status: Extract<ReleaseStatus, "SUCCEEDED" | "FAILED">;
  runUrl?: string;
  updatedAt: Date;
}): string {
  const lines = [
    `🚀 **${input.displayName} ${input.version} · 전체 마켓 배포**`,
    "",
    `배포 워크플로: ${WORKFLOW_STATUS_LABEL[input.status]}`,
    input.status === "SUCCEEDED"
      ? "마켓별 업로드 결과는 실행의 잡 결과에서 확인한다."
      : "마켓 업로드가 진행되지 않았을 수 있다. 실행 로그를 확인한다.",
  ];
  if (input.runUrl) lines.push(`[실행 결과 보기](${input.runUrl})`);
  lines.push(`마지막 갱신: ${formatKst(input.updatedAt)}`);
  return lines.join("\n");
}

export function buildDeployStatusCardText(input: {
  displayName: string;
  version: string;
  market: ReleaseMarket;
  status: ReleaseStatus;
  workflowName?: string | null;
  externalBuildNumber?: number | null;
  runUrl?: string;
  updatedAt: Date;
}): string {
  const lines = [
    `🚀 **${input.displayName} ${input.version} · ${MARKET_LABEL[input.market]}**`,
    "",
    `빌드·업로드 워크플로: ${WORKFLOW_STATUS_LABEL[input.status]}`,
    ...REMAINING_GATES[input.market],
  ];
  if (input.workflowName) lines.push(`실행: ${input.workflowName}`);
  if (input.externalBuildNumber != null) lines.push(`Xcode Cloud 빌드: #${input.externalBuildNumber}`);
  if (input.runUrl) lines.push(`[실행 결과 보기](${input.runUrl})`);
  lines.push(`마지막 갱신: ${formatKst(input.updatedAt)}`);
  return lines.join("\n");
}

// ── 배포 카드 액션 버튼 ────────────────────────────────────────────────────────

/** 카드 버튼이 트리거하는 마켓 후속 작업. custom_id 의 action 부분과 1:1. */
export const DEPLOY_CARD_ACTIONS = [
  "play_promote",
  "appstore_review_create",
  "appstore_review_submit",
  "appstore_review_remove",
  "appstore_review_cancel",
  "appstore_refresh",
] as const;

export type DeployCardAction = (typeof DEPLOY_CARD_ACTIONS)[number];

export const DEPLOY_CARD_ACTION_KO: Record<DeployCardAction, string> = {
  play_promote: "Google Play 프로덕션 승격",
  appstore_review_create: "App Store 심사 생성",
  appstore_review_submit: "App Store 심사 제출",
  appstore_review_remove: "App Store 심사 삭제",
  appstore_review_cancel: "App Store 제출 취소",
  appstore_refresh: "App Store 상태 새로고침",
};

/** 카드 렌더에 필요한 App Store 심사 단계. ASC 라이브 조회 결과에서 뽑는다. */
export interface AppStoreReviewCardState {
  appStoreState: string | null;
  versionEditable: boolean;
  submissionState: string | null;
  /** 이 버전이 열린 심사 제출의 항목으로 들어가 있는지. */
  hasSubmissionItem: boolean;
}

// 제출 뒤 회수(취소)가 가능한 심사 제출 상태.
const CANCELABLE_SUBMISSION_STATES = new Set([
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "UNRESOLVED_ISSUES",
]);

export function deployCardCustomId(action: DeployCardAction, releaseRecordId: string): string {
  return `deploycard:${action}:${releaseRecordId}`;
}

function button(
  action: DeployCardAction,
  releaseRecordId: string,
  style: 1 | 2 | 4,
): DiscordActionRow["components"][number] {
  return {
    type: 2,
    style,
    label: DEPLOY_CARD_ACTION_KO[action].replace(/^(Google Play|App Store) /, ""),
    custom_id: deployCardCustomId(action, releaseRecordId),
  };
}

function row(components: DiscordActionRow["components"]): DiscordActionRow[] {
  return components.length ? [{ type: 1, components }] : [];
}

/** App Store 심사 단계 → 지금 실행 가능한 액션만. */
function appStoreButtons(
  releaseRecordId: string,
  review: AppStoreReviewCardState | null,
): DiscordActionRow["components"] {
  // 상태를 못 읽었으면 임의 액션을 노출하지 않고 새로고침만 남긴다.
  if (!review) return [button("appstore_refresh", releaseRecordId, 2)];
  const refresh = button("appstore_refresh", releaseRecordId, 2);

  if (review.hasSubmissionItem) {
    if (review.submissionState === "READY_FOR_REVIEW") {
      return [
        button("appstore_review_submit", releaseRecordId, 4),
        button("appstore_review_remove", releaseRecordId, 2),
        refresh,
      ];
    }
    if (CANCELABLE_SUBMISSION_STATES.has(review.submissionState ?? "")) {
      return [button("appstore_review_cancel", releaseRecordId, 2), refresh];
    }
    // COMPLETING·CANCELING 은 ASC 가 처리 중이라 개입할 수 없다.
    return [refresh];
  }

  // 다른 버전이 이미 제출된 열린 심사를 점유하면 이 버전을 항목으로 넣을 수 없다.
  if (review.submissionState && review.submissionState !== "READY_FOR_REVIEW") return [refresh];
  if (review.appStoreState && !review.versionEditable) return [refresh];
  return [button("appstore_review_create", releaseRecordId, 1), refresh];
}

// 후속 마켓 작업은 모두 릴리즈 태그를 기준으로 동작한다. 태그를 못 찾은 배포
// (mirror 의 "untagged")는 버튼도, 그 버튼을 그리기 위한 외부 조회도 의미가 없다.
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;

export function isReleaseTag(version: string): boolean {
  return RELEASE_TAG_RE.test(version);
}

/**
 * 배포 카드에 붙일 액션 버튼. 업로드가 성공한 뒤에만 후속 마켓 작업을 노출한다.
 * 승격을 이미 트리거한 태그에는 승격 버튼을 다시 달지 않는다(승격 실행 자체의 카드 포함).
 */
export function deployCardComponents(input: {
  releaseRecordId: string;
  market: ReleaseMarket;
  status: ReleaseStatus;
  version: string;
  /** 같은 앱·버전에 실패하지 않은 production 승격 배포가 이미 있는지. */
  promotionRequested?: boolean;
  review?: AppStoreReviewCardState | null;
}): DiscordActionRow[] {
  if (input.status !== "SUCCEEDED") return [];
  if (!isReleaseTag(input.version)) return [];
  if (input.market === "PLAY") {
    if (input.promotionRequested) return [];
    return row([button("play_promote", input.releaseRecordId, 4)]);
  }
  if (input.market === "APPSTORE") {
    return row(appStoreButtons(input.releaseRecordId, input.review ?? null));
  }
  return [];
}
