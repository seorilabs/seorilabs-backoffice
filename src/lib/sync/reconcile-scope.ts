import type { Prisma } from "@prisma/client";

// GitHub은 Issue/PR의 정본이고 RepositoryRegistration은 설치에 보이는 저장소 원장이다.
// 제품 App만 순회하면 INFRA_REPO의 webhook 유실을 복구할 수 없으므로 active registration
// 전체를 reconcile한다.
export const reconcileRepositoryWhere = {
  archived: false,
  status: { not: "ARCHIVED" },
} satisfies Prisma.RepositoryRegistrationWhereInput;
