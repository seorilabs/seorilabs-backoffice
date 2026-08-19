import { Prisma } from "@prisma/client";

// 되돌리기 어렵거나 외부에 즉시 공개되는 작업만 2단계 확인을 요구한다.
// 심사 생성·삭제·상태 조회는 같은 카드에서 되돌릴 수 있어 즉시 실행한다.
const CONFIRMATION_REQUIRED_OPERATIONS = new Set([
  "release_create",
  "deploy",
  "index",
  "play_promote",
  "appstore_review_submit",
  "appstore_review_cancel",
]);

export function requiresOperatorConfirmation(operation: string): boolean {
  return CONFIRMATION_REQUIRED_OPERATIONS.has(operation);
}

export function confirmationClaimWhere(input: {
  id: string;
  actorDiscordUserId: string;
  now: Date;
}): Prisma.OperatorCommandRunWhereInput {
  return {
    id: input.id,
    actorDiscordUserId: input.actorDiscordUserId,
    status: "AWAITING_CONFIRMATION",
    expiresAt: { gt: input.now },
  };
}
