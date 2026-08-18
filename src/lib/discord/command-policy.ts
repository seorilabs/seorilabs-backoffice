import { Prisma } from "@prisma/client";

const CONFIRMATION_REQUIRED_OPERATIONS = new Set(["release_create", "deploy", "index"]);

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
