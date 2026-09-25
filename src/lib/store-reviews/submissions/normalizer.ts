import type { StoreReviewStore } from "@prisma/client";

export type SubmissionEmoji = "…" | "⟳" | "✓" | "✗" | "⏹";

export const STORE_NAME: Record<StoreReviewStore, string> = {
  APP_STORE: "App Store",
  GOOGLE_PLAY: "Google Play",
};

export const STORE_COLOR_HEX: Record<StoreReviewStore, number> = {
  APP_STORE: 0x0a84ff,
  GOOGLE_PLAY: 0x34a853,
};

interface StateEntry {
  readonly label: string;
  readonly emoji: SubmissionEmoji;
}

const APPLE_STATE_TABLE: Readonly<Record<string, StateEntry>> = {
  ACCEPTED: { label: "접수 완료", emoji: "✓" },
  PENDING_CONTRACT: { label: "계약 대기", emoji: "…" },
  PREORDER_READY_FOR_SALE: { label: "사전 주문 출시 준비", emoji: "✓" },
  WAITING_FOR_EXPORT_COMPLIANCE: { label: "수출 규정 확인 대기", emoji: "…" },
  NOT_APPLICABLE: { label: "해당 없음", emoji: "⏹" },
  PREPARE_FOR_SUBMISSION: { label: "제출 준비", emoji: "…" },
  READY_FOR_REVIEW: { label: "심사 제출 준비", emoji: "…" },
  WAITING_FOR_REVIEW: { label: "심사 대기", emoji: "…" },
  PENDING_APPLE_RELEASE: { label: "Apple 출시 대기", emoji: "⟳" },
  PENDING_DEVELOPER_RELEASE: { label: "개발자 출시 대기", emoji: "⟳" },
  PROCESSING_FOR_APP_STORE: { label: "스토어 처리 중", emoji: "⟳" },
  METADATA_REJECTED: { label: "메타데이터 거절", emoji: "✗" },
  INVALID_BINARY: { label: "빌드 무효", emoji: "✗" },
  REMOVED_FROM_SALE: { label: "판매 중단", emoji: "⏹" },
  REPLACED_WITH_NEW_VERSION: { label: "새 버전으로 교체", emoji: "⏹" },
  PREPROCESSING: { label: "사전 검토", emoji: "…" },
  IN_REVIEW: { label: "심사 중", emoji: "⟳" },
  REJECTED: { label: "심사 거절", emoji: "✗" },
  APPROVED: { label: "심사 통과", emoji: "✓" },
  READY_FOR_SALE: { label: "출시 가능", emoji: "✓" },
  DEVELOPER_REJECTED: { label: "개발자 회수", emoji: "⏹" },
  DEVELOPER_REMOVED_FROM_SALE: { label: "스토어에서 회수", emoji: "⏹" },
};

const GOOGLE_PLAY_STATE_TABLE: Readonly<Record<string, StateEntry>> = {
  completed: { label: "출시 완료", emoji: "✓" },
  inProgress: { label: "단계별 출시 중", emoji: "⟳" },
  halted: { label: "출시 보류", emoji: "✗" },
  draft: { label: "작성 중", emoji: "…" },
};

export interface NormalizedState {
  readonly store: StoreReviewStore;
  readonly state: string;
  readonly stateLabel: string;
  readonly emoji: SubmissionEmoji;
  readonly storeColorHex: number;
}

export function normalizeSubmissionState(input: {
  store: StoreReviewStore;
  state: string;
}): NormalizedState {
  const table =
    input.store === "APP_STORE" ? APPLE_STATE_TABLE : GOOGLE_PLAY_STATE_TABLE;
  const entry = table[input.store === "GOOGLE_PLAY" ? input.state.split(":")[0]! : input.state];
  if (!entry) {
    throw new Error(
      `알 수 없는 ${input.store} state: ${input.state}`,
    );
  }
  return {
    store: input.store,
    state: input.state,
    stateLabel: entry.label,
    emoji: entry.emoji,
    storeColorHex: STORE_COLOR_HEX[input.store],
  };
}
