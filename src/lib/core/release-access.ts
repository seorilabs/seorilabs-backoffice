import type { UserRole } from "@prisma/client";

import { HIDDEN_APP_ERROR, isDisabledAppStatus } from "@/lib/domain/app-visibility";

export class ReleaseAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseAccessError";
  }
}

export interface ReleaseWriteSubject {
  role: UserRole;
  allowlisted: boolean;
  isAppOwner: boolean;
}

export interface ReleaseWriteActor {
  userId: string;
  login: string;
  role: UserRole;
  appId: string;
  repoFullName: string;
}

/** 릴리스 write는 ADMIN 또는 해당 앱 OWNER인 MAINTAINER만 수행한다. */
export function assertReleaseWriteAccess(subject: ReleaseWriteSubject): void {
  if (!subject.allowlisted) {
    throw new ReleaseAccessError("릴리스 운영 권한이 없습니다.");
  }
  if (subject.role === "ADMIN") return;
  if (subject.role === "MAINTAINER" && subject.isAppOwner) return;
  throw new ReleaseAccessError("해당 앱의 릴리스 운영 권한이 없습니다.");
}

/** 세션 claim이 아니라 현재 DB role, allowlist, AppOwner, 앱 상태를 mutation 직전에 확인한다. */
export async function requireReleaseWriteAccess(appId: string): Promise<ReleaseWriteActor> {
  const [{ requireSession }, { prisma }] = await Promise.all([
    import("@/lib/auth-helpers"),
    import("@/lib/prisma"),
  ]);
  const session = await requireSession();
  const login = session.user.login?.trim();
  if (!login) {
    throw new ReleaseAccessError("GitHub 로그인 정보를 확인할 수 없습니다.");
  }

  const user = await prisma.user.findUnique({
    where: { login },
    select: { id: true, login: true, role: true, allowlisted: true },
  });
  if (!user) {
    throw new ReleaseAccessError("백오피스 사용자 정보를 확인할 수 없습니다.");
  }

  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: {
      id: true,
      repoFullName: true,
      status: true,
      owners: {
        where: { userId: user.id, role: "OWNER" },
        select: { userId: true },
        take: 1,
      },
    },
  });
  if (!app) throw new ReleaseAccessError("앱을 찾을 수 없습니다.");
  if (isDisabledAppStatus(app.status)) throw new ReleaseAccessError(HIDDEN_APP_ERROR);

  assertReleaseWriteAccess({
    role: user.role,
    allowlisted: user.allowlisted,
    isAppOwner: app.owners.length > 0,
  });
  return {
    userId: user.id,
    login: user.login,
    role: user.role,
    appId: app.id,
    repoFullName: app.repoFullName,
  };
}
