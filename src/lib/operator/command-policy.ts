import type { OperatorCapability } from "./roles";
import { Prisma } from "@prisma/client";

// 되돌리기 어렵거나 외부에 즉시 공개되는 작업만 2단계 확인을 요구한다.
// 심사 생성·삭제·상태 조회는 같은 카드에서 되돌릴 수 있어 즉시 실행한다.
const CONFIRMATION_REQUIRED_OPERATIONS = new Set([
  "platform_deployment_review",
  "release_create",
  "deploy",
  "snapshot_deploy",
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
  actorUserId: string;
  channelId: string;
  now: Date;
}): Prisma.OperatorCommandRunWhereInput {
  return {
    id: input.id,
    sourceProvider: "SLACK",
    actorUserId: input.actorUserId,
    channelId: input.channelId,
    status: "AWAITING_CONFIRMATION",
    expiresAt: { gt: input.now },
  };
}

export function operationCapability(operation: string, params: { gate?: unknown } = {}): OperatorCapability {
  if (operation === "platform_deployment_review") return "release_approval";
  if (operation === "approval") {
    if (params.gate === "release") return "release_approval";
    if (params.gate === "planning") return "planning_approval";
    throw new Error("지원하지 않는 승인 종류입니다.");
  }
  if (
    operation === "incident_ack" ||
    operation === "incident_assign" ||
    operation === "incident_resolve"
  )
    return "ops_incident";
  if (operation.startsWith("release_") || operation === "deploy")
    return "release";
  if (operation.startsWith("snapshot_")) return "release";
  if (operation === "play_promote" || operation.startsWith("appstore_"))
    return "release";
  if (operation === "index") return "vault_index";
  if (operation === "save") return "vault_write";
  if (operation === "plan_generate" || operation === "stage_generate")
    return "planning";
  if (operation === "draft_commit" || operation === "general_generate" || operation === "general_readback") return "issue_write";
  if (operation === "bug_generate") return "bug";
  return "read";
}

