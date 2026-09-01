import type { AppStatus, Prisma } from "@prisma/client";

export const DISABLED_APP_STATUS = "DEPRECATED" satisfies AppStatus;
export const WRITABLE_APP_STATUSES = ["ACTIVE", "PAUSED"] as const satisfies readonly AppStatus[];

export const HIDDEN_APP_ERROR =
  "비활성 앱은 백오피스에서 사용할 수 없습니다. 복구는 DB에서 status를 ACTIVE로 변경해야 합니다.";

export const visibleAppWhere = {
  status: { not: DISABLED_APP_STATUS },
} satisfies Prisma.AppWhereInput;

export const activeAppWhere = {
  status: "ACTIVE",
} satisfies Prisma.AppWhereInput;

export const visibleIssueWhere = {
  app: { is: visibleAppWhere },
} satisfies Prisma.IssueMirrorWhereInput;

// 승인 원장은 제품 앱뿐 아니라 조직 인프라 저장소의 사람 gate도 보여야 한다.
// appId가 없는 이슈는 RepositoryRegistration으로 관리되는 INFRA_REPO일 수 있으므로
// 숨기지 않는다. 승인 라벨도 DB에서 먼저 제한해 조회 상한 전에 다른 OPEN 이슈가
// 승인 항목을 밀어내지 못하게 한다.
export const approvalIssueWhere = {
  AND: [
    { OR: [visibleIssueWhere, { appId: null }] },
    {
      OR: [
        { labels: { array_contains: "approval:planning" } },
        { labels: { array_contains: "approval:release" } },
      ],
    },
  ],
} satisfies Prisma.IssueMirrorWhereInput;

export const visiblePrWhere = {
  app: { is: visibleAppWhere },
} satisfies Prisma.PullRequestMirrorWhereInput;

export const visibleReleaseWhere = {
  app: visibleAppWhere,
} satisfies Prisma.ReleaseRecordWhereInput;

export const visibleReleaseNoteWhere = {
  app: visibleAppWhere,
} satisfies Prisma.ReleaseNoteWhereInput;

export function isDisabledAppStatus(status: AppStatus): status is typeof DISABLED_APP_STATUS {
  return status === DISABLED_APP_STATUS;
}

export function isWritableAppStatus(status: string): status is (typeof WRITABLE_APP_STATUSES)[number] {
  return (WRITABLE_APP_STATUSES as readonly string[]).includes(status);
}
