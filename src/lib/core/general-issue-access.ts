import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { assertPlatformWriteAccess } from "@/lib/platform/access";
import { hasDiscordCapability } from "@/lib/discord/roles";
import { visibleAppWhere } from "@/lib/domain/app-visibility";

export function requireGeneralIssuesEnabled() {
  if (!env.featureGeneralIssues()) throw new Error("일반 이슈 등록은 현재 비활성 상태입니다.");
}

export interface GeneralIssueActor {
  actorLabel: string;
  expectedGithubId?: string;
  /** 서명 검증을 마친 interaction의 역할. 워커는 생략하고 Discord에서 다시 읽는다. */
  discordRoles?: string[];
}

export async function requireGeneralIssueAccess(appId: string, actor: GeneralIssueActor, db = prisma, request = fetch) {
  let githubId: bigint | undefined;
  if (actor.actorLabel.startsWith("discord:")) {
    const discordUserId = actor.actorLabel.slice(8);
    const link = await db.discordAccountLink.findUnique({ where: { discordUserId } });
    if (!link || (actor.expectedGithubId && String(link.githubId) !== actor.expectedGithubId))
      throw new Error("GitHub 계정 연결을 확인하세요. /account connect로 연결할 수 있습니다.");
    githubId = link.githubId;
    let roles = actor.discordRoles;
    if (!roles) {
      const response = await request(`https://discord.com/api/v10/guilds/${env.discordGuildId()}/members/${encodeURIComponent(discordUserId)}`, {
        headers: { Authorization: `Bot ${env.discordBotToken()}` }, signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error("현재 Discord 역할을 확인할 수 없습니다.");
      const member = await response.json() as { roles?: unknown };
      if (!Array.isArray(member.roles) || !member.roles.every(r => typeof r === "string")) throw new Error("Discord 역할 응답이 올바르지 않습니다.");
      roles = member.roles as string[];
    }
    if (!hasDiscordCapability(roles, "issue_write")) throw new Error("기획 또는 버그 작성 역할이 필요합니다.");
  } else if (!actor.actorLabel.startsWith("@")) {
    throw new Error("작성자를 확인할 수 없습니다.");
  }
  const user = await db.user.findUnique({ where: githubId ? { githubId } : { login: actor.actorLabel.slice(1) } });
  if (!user || (actor.expectedGithubId && String(user.githubId) !== actor.expectedGithubId)) throw new Error("현재 GitHub 사용자를 확인할 수 없습니다.");
  const app = await db.app.findFirst({
    where: { id: appId, ...visibleAppWhere },
    include: { owners: { where: { userId: user.id, role: "OWNER" }, take: 1 } },
  });
  if (!app) throw new Error("앱을 찾을 수 없습니다.");
  assertPlatformWriteAccess({ role: user.role, allowlisted: user.allowlisted, isAppOwner: app.owners.length > 0 });
  return { app, login: user.login, githubId: String(user.githubId) };
}
