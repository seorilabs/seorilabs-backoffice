import type { UserRole } from "@prisma/client";

import { resolvedPlatformAppId } from "./app-id";

export class PlatformAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformAccessError";
  }
}

export interface PlatformAccessSubject {
  role: UserRole;
  allowlisted: boolean;
}

export interface PlatformWriteAccessSubject extends PlatformAccessSubject {
  isAppOwner: boolean;
}

export interface PlatformActor {
  userId: string;
  login: string;
  role: UserRole;
}

export interface PlatformWriteActor extends PlatformActor {
  appId: string;
  appSlug: string;
}

export interface QueuedPlatformAccessSnapshot {
  runAppId: string;
  runActorLogin: string | null;
  requestedAppSlug: string;
  app: {
    id: string;
    slug: string;
    platformAppId: string | null;
    active: boolean;
  } | null;
  user: {
    id: string;
    login: string;
    role: UserRole;
    allowlisted: boolean;
    isAppOwner: boolean;
  } | null;
}

/** 플랫폼 전역 조회는 DB에서 확인한 ADMIN/MAINTAINER에게만 허용한다. */
export function assertPlatformReadAccess(
  subject: PlatformAccessSubject,
): void {
  if (
    !subject.allowlisted ||
    (subject.role !== "ADMIN" && subject.role !== "MAINTAINER")
  ) {
    throw new PlatformAccessError("플랫폼 관리 조회 권한이 없습니다.");
  }
}

/**
 * 원장 write는 ADMIN, 또는 해당 앱 소유권이 있는 MAINTAINER만 허용한다.
 * 세션 claim을 믿지 않고 action이 DB User/AppOwner를 조회한 결과를 넘긴다.
 */
export function assertPlatformWriteAccess(
  subject: PlatformWriteAccessSubject,
): void {
  assertPlatformReadAccess(subject);
  if (subject.role === "ADMIN") return;
  if (subject.role === "MAINTAINER" && subject.isAppOwner) return;
  throw new PlatformAccessError("해당 앱의 플랫폼 관리 변경 권한이 없습니다.");
}

/**
 * 큐 row를 권한 증명으로 믿지 않는다. worker가 현재 DB 상태와 다시 결합할 때
 * 사용하는 순수 판정 함수다. 직접 row 삽입, 권한 회수 뒤 실행, app 바꿔치기를
 * 막지만 DB 자체의 무결성이 깨진 상황까지 보안 경계로 주장하지 않는다.
 */
function assertQueuedPlatformBinding(
  snapshot: QueuedPlatformAccessSnapshot,
): void {
  if (
    !snapshot.user ||
    !snapshot.runActorLogin ||
    snapshot.user.login !== snapshot.runActorLogin
  ) {
    throw new PlatformAccessError(
      "플랫폼 큐 요청의 현재 운영자 권한을 확인할 수 없습니다.",
    );
  }
  if (
    !snapshot.app ||
    !snapshot.app.active ||
    snapshot.app.id !== snapshot.runAppId ||
    resolvedPlatformAppId(snapshot.app) !== snapshot.requestedAppSlug
  ) {
    throw new PlatformAccessError(
      "플랫폼 큐 요청의 앱 결합 또는 활성 상태를 확인할 수 없습니다.",
    );
  }
}

export function assertQueuedPlatformReadAccess(
  snapshot: QueuedPlatformAccessSnapshot,
): void {
  assertQueuedPlatformBinding(snapshot);
  assertPlatformReadAccess({
    role: snapshot.user!.role,
    allowlisted: snapshot.user!.allowlisted,
  });
}

export function assertQueuedPlatformWriteAccess(
  snapshot: QueuedPlatformAccessSnapshot,
): void {
  assertQueuedPlatformBinding(snapshot);
  assertPlatformWriteAccess({
    role: snapshot.user!.role,
    allowlisted: snapshot.user!.allowlisted,
    isAppOwner: snapshot.user!.isAppOwner,
  });
}

async function currentPlatformUser(): Promise<PlatformActor & { allowlisted: boolean }> {
  // 테스트에서 순수 권한 판정 함수를 불러올 때 NextAuth/Prisma를 초기화하지 않도록
  // 서버 의존성은 실제 action 실행 시점에만 로드한다.
  const [{ requireSession }, { prisma }] = await Promise.all([
    import("@/lib/auth-helpers"),
    import("@/lib/prisma"),
  ]);
  const session = await requireSession();
  const login = session.user.login?.trim();
  if (!login) {
    throw new PlatformAccessError("GitHub 로그인 정보를 확인할 수 없습니다.");
  }

  const user = await prisma.user.findUnique({
    where: { login },
    select: { id: true, login: true, role: true, allowlisted: true },
  });
  if (!user) {
    throw new PlatformAccessError("백오피스 사용자 정보를 확인할 수 없습니다.");
  }
  return { userId: user.id, login: user.login, role: user.role, allowlisted: user.allowlisted };
}

/** 세션 claim이 아니라 현재 DB의 allowlist/role을 다시 확인한다. */
export async function requirePlatformReadAccess(): Promise<PlatformActor> {
  const user = await currentPlatformUser();
  assertPlatformReadAccess(user);
  return { userId: user.userId, login: user.login, role: user.role };
}

/**
 * 플랫폼 write는 DB 앱 레지스트리와 AppOwner를 함께 확인한다.
 * ADMIN도 존재하지 않는 앱을 대상으로 원장 작업을 만들 수 없다.
 */
export async function requirePlatformWriteAccess(
  appSlug: string,
): Promise<PlatformWriteActor> {
  const user = await currentPlatformUser();
  const { prisma } = await import("@/lib/prisma");
  const app = await prisma.app.findFirst({
    where: {
      status: "ACTIVE",
      OR: [
        { platformAppId: appSlug },
        { platformAppId: null, slug: appSlug },
      ],
    },
    select: {
      id: true,
      slug: true,
      platformAppId: true,
      owners: {
        where: { userId: user.userId, role: "OWNER" },
        select: { userId: true },
        take: 1,
      },
    },
  });
  if (!app) {
    throw new PlatformAccessError("플랫폼 앱 레지스트리에 연결된 앱을 찾을 수 없습니다.");
  }

  assertPlatformWriteAccess({
    role: user.role,
    allowlisted: user.allowlisted,
    isAppOwner: app.owners.length > 0,
  });
  return {
    userId: user.userId,
    login: user.login,
    role: user.role,
    appId: app.id,
    appSlug: resolvedPlatformAppId(app),
  };
}

/** worker가 외부 write identity를 쓰기 직전에 큐의 actor/app 권한을 재검증한다. */
export async function revalidateQueuedPlatformWriteAccess(input: {
  appId: string;
  appSlug: string;
  actorLogin: string | null;
}): Promise<PlatformWriteActor> {
  return revalidateQueuedPlatformAccess({ ...input, intent: "write" });
}

export async function revalidateQueuedPlatformReadAccess(input: {
  appId: string;
  appSlug: string;
  actorLogin: string | null;
}): Promise<PlatformWriteActor> {
  return revalidateQueuedPlatformAccess({ ...input, intent: "read" });
}

async function revalidateQueuedPlatformAccess(input: {
  appId: string;
  appSlug: string;
  actorLogin: string | null;
  intent: "read" | "write";
}): Promise<PlatformWriteActor> {
  const { prisma } = await import("@/lib/prisma");
  return prisma.$transaction(async (tx) => {
    const user = input.actorLogin
      ? await tx.user.findUnique({
          where: { login: input.actorLogin },
          select: {
            id: true,
            login: true,
            role: true,
            allowlisted: true,
          },
        })
      : null;
    const app = await tx.app.findUnique({
      where: { id: input.appId },
      select: {
        id: true,
        slug: true,
        platformAppId: true,
        status: true,
        owners: {
          where: user
            ? { userId: user.id, role: "OWNER" }
            : { userId: "__missing_platform_actor__", role: "OWNER" },
          select: { userId: true },
          take: 1,
        },
      },
    });

    const snapshot: QueuedPlatformAccessSnapshot = {
      runAppId: input.appId,
      runActorLogin: input.actorLogin,
      requestedAppSlug: input.appSlug,
      app: app
        ? {
            id: app.id,
            slug: app.slug,
            platformAppId: app.platformAppId,
            active: app.status === "ACTIVE",
          }
        : null,
      user: user
        ? {
            ...user,
            isAppOwner: (app?.owners.length ?? 0) > 0,
          }
        : null,
    };
    if (input.intent === "write") {
      assertQueuedPlatformWriteAccess(snapshot);
    } else {
      assertQueuedPlatformReadAccess(snapshot);
    }

    return {
      userId: user!.id,
      login: user!.login,
      role: user!.role,
      appId: app!.id,
      appSlug: resolvedPlatformAppId(app!),
    };
  });
}
