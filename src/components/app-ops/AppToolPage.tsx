import { notFound } from "next/navigation";

import { ToolCatalog, WorkspaceSection } from "@/components/app-ops/WorkspaceUi";
import {
  toolsForSection,
  type AppOpsSection,
} from "@/lib/app-ops/manifest";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { prisma } from "@/lib/prisma";

const SECTION_COPY: Record<
  Exclude<AppOpsSection, "content" | "ads">,
  {
    title: string;
    description: string;
    emptyTitle: string;
    emptyDescription: string;
    principles: string[];
  }
> = {
  operations: {
    title: "앱 전용 오퍼레이션",
    description: "통계 재집계, 배치 실행, 콘텐츠 발행처럼 게임 고유의 운영 작업을 선언합니다.",
    emptyTitle: "앱 전용 오퍼레이션이 아직 없습니다",
    emptyDescription: "게임 저장소에서 도구와 입력 계약을 선언하면 이 영역에 자동으로 나타납니다.",
    principles: [
      "조회와 변경 오퍼레이션을 명확히 분리",
      "변경 작업은 사유 또는 문구 재확인 필수",
      "실행 결과는 GitHub workflow_run으로 감사",
    ],
  },
  commerce: {
    title: "결제·IAP",
    description: "상품, 테스트 계정, entitlement 지급·회수와 구매 검증을 안전하게 관리합니다.",
    emptyTitle: "IAP 관리 계약이 아직 없습니다",
    emptyDescription:
      "IAP이 있는 게임은 테스트 계정 조회, 무료 지급, 회수, 구매 검증 오퍼레이션을 manifest에 선언합니다.",
    principles: [
      "계정 비밀번호와 스토어 토큰은 저장하거나 입력받지 않음",
      "테스트 계정은 비밀값이 아닌 내부 참조 ID로 식별",
      "지급·회수는 고위험 작업으로 문구 재확인과 멱등 키 적용",
    ],
  },
  flags: {
    title: "Feature Flags",
    description: "기능 노출, 실험군, 단계적 롤아웃과 긴급 비활성화를 관리합니다.",
    emptyTitle: "Feature Flag 관리 계약이 아직 없습니다",
    emptyDescription:
      "게임 저장소에서 조회·변경 가능한 플래그 그룹과 입력 계약을 선언하면 이 영역에 표시됩니다.",
    principles: [
      "환경과 마켓을 명시한 뒤 값 변경",
      "현재 값과 목표 값을 함께 기록",
      "긴급 kill switch와 일반 실험 플래그의 승인 수준 분리",
    ],
  },
};

export async function AppToolPage({
  appId,
  section,
}: {
  appId: string;
  section: Exclude<AppOpsSection, "content" | "ads">;
}) {
  const app = await prisma.app.findFirst({
    where: { id: appId, ...visibleAppWhere },
    select: {
      repoFullName: true,
      opsManifest: true,
    },
  });
  if (!app) notFound();
  const copy = SECTION_COPY[section];
  const tools = toolsForSection(app.opsManifest, section);

  return (
    <div className="space-y-6">
      <WorkspaceSection title={copy.title} description={copy.description}>
        <div className="mb-4 grid gap-2 md:grid-cols-3">
          {copy.principles.map((principle) => (
            <div
              key={principle}
              className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600"
            >
              {principle}
            </div>
          ))}
        </div>
        <ToolCatalog
          tools={tools}
          repoFullName={app.repoFullName}
          emptyTitle={copy.emptyTitle}
          emptyDescription={copy.emptyDescription}
        />
      </WorkspaceSection>
    </div>
  );
}
