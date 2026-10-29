import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { assertPlatformWriteAccess } from "@/lib/platform/access";
import { hasOperatorCapability } from "@/lib/operator/roles";
import { currentOperatorRoles } from "@/lib/notifications/channel";
import { visibleAppWhere } from "@/lib/domain/app-visibility";

export function requireGeneralIssuesEnabled() {
  if (!env.featureGeneralIssues()) throw new Error("일반 이슈 등록은 현재 비활성 상태입니다.");
}

export interface GeneralIssueActor {
  actorLabel: string;
  expectedGithubId?: string;
  /** 서명 검증을 마친 interaction의 역할. 워커는 생략하고 Slack에서 다시 읽는다. */
  operatorRoles?: string[];
}

export async function requireGeneralIssueAccess(appId: string, actor: GeneralIssueActor, db = prisma, request = fetch) {
  let githubId: bigint | undefined;
  if (actor.actorLabel.startsWith("slack:")) {
    const slackUserId = actor.actorLabel.slice(6);
    const link = await db.slackAccountLink.findUnique({ where: { slackUserId } });
    if (!link || (actor.expectedGithubId && String(link.githubId) !== actor.expectedGithubId))
      throw new Error("GitHub 계정 연결을 확인하세요. /seori account connect로 연결할 수 있습니다.");
    githubId = link.githubId;
    let roles = actor.operatorRoles;
    if (!roles) {
      roles = await currentOperatorRoles(slackUserId, request);
    }
    if (!hasOperatorCapability(roles, "issue_write")) throw new Error("기획 또는 버그 작성 역할이 필요합니다.");
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
