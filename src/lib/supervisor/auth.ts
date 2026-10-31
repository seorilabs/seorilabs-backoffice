import { NextRequest } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { env } from "@/lib/env";
import { ensure } from "./contracts";
import { supervisorSlackChannelId } from "./channel";
export function machinePrincipal(request: NextRequest): string | null {
  const owner = process.env.SUPERVISOR_MACHINE_ID?.trim();
  if (!owner || request.headers.get("x-supervisor-machine") !== owner)
    return null;
  const authorization = request.headers.get("authorization");
  return verifyStaticToken(
    authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
    process.env.INTERNAL_ADMIN_TOKEN,
  )
    ? owner
    : null;
}
export async function requireHuman(request?: NextRequest): Promise<string> {
  if (request) {
    ensure(
      !request.headers.has("authorization") &&
        !request.headers.has("x-supervisor-machine"),
      "HUMAN_SESSION_REQUIRED",
      403,
    );
    if (request.method !== "GET") {
      const origin =
        process.env.AUTH_URL ||
        process.env.NEXTAUTH_URL ||
        "https://backoffice.vzyx.xyz";
      ensure(
        request.headers.get("origin") === new URL(origin).origin,
        "ORIGIN_DENIED",
        403,
      );
    }
  }
  const { auth } = await import("@/auth");
  const { prisma } = await import("@/lib/prisma");
  const session = await auth();
  ensure(session?.user, "HUMAN_SESSION_REQUIRED", 401);
  const login = session.user.login;
  ensure(
    login && login === process.env.SUPERVISOR_OWNER_LOGIN?.trim(),
    "SUPERVISOR_OWNER_REQUIRED",
    403,
  );
  const user = await prisma.user.findUnique({
    where: { login },
    select: { role: true, allowlisted: true },
  });
  ensure(
    user?.allowlisted && user.role === "ADMIN",
    "SUPERVISOR_OWNER_REQUIRED",
    403,
  );
  return "@" + login;
}
export function requireSlackOwner(input: {
  workspaceId: string;
  channelId: string;
  userId: string;
}) {
  ensure(
    !!process.env.SUPERVISOR_SLACK_OWNER_ID &&
      input.userId === process.env.SUPERVISOR_SLACK_OWNER_ID &&
      input.workspaceId === env.slackWorkspaceId() &&
      !!supervisorSlackChannelId() &&
      input.channelId === supervisorSlackChannelId(),
    "SUPERVISOR_SLACK_SCOPE_DENIED",
    403,
  );
  return "slack:" + input.userId;
}
