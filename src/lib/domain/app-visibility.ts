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
