import { notFound } from "next/navigation";

import { ToolCatalog, WorkspaceSection } from "@/components/app-ops/WorkspaceUi";
import { toolsForSection } from "@/lib/app-ops/manifest";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { isoDate } from "@/lib/ga4/datasets";
import { prisma } from "@/lib/prisma";

export default async function CommercePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const app = await prisma.app.findFirst({
    where: { id, ...visibleAppWhere },
    select: {
      id: true,
      repoFullName: true,
      opsManifest: true,
    },
  });
  if (!app) notFound();
  const latest = await prisma.appConsoleMetricDaily.findFirst({
    where: { appId: app.id },
    orderBy: { date: "desc" },
    select: {
      date: true,
      iapTrxAmountKrw: true,
      iapSettlementKrw: true,
      payingUsers: true,
    },
  });
  const tools = toolsForSection(app.opsManifest, "commerce");

  return (
    <div className="space-y-8">
      <WorkspaceSection
        title="IAP 현황"
        description="AppsInToss 콘솔의 결제 거래액, 정산액과 결제 사용자 최신 스냅샷입니다."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <CommerceCard
            label="거래액"
            value={
              latest
                ? `₩${Math.round(latest.iapTrxAmountKrw).toLocaleString("ko-KR")}`
                : undefined
            }
            date={latest?.date}
          />
          <CommerceCard
            label="정산액"
            value={
              latest
                ? `₩${Math.round(latest.iapSettlementKrw).toLocaleString("ko-KR")}`
                : undefined
            }
            date={latest?.date}
          />
          <CommerceCard label="결제 사용자" value={latest?.payingUsers} date={latest?.date} />
        </div>
      </WorkspaceSection>

      <WorkspaceSection
        title="테스트 계정과 Entitlement"
        description="상품, 테스트 계정 참조, 무료 지급, 회수와 구매 검증 오퍼레이션을 관리합니다."
      >
        <div className="mb-4 grid gap-2 md:grid-cols-3">
          {[
            "계정 비밀번호와 스토어 토큰은 저장하거나 입력받지 않음",
            "테스트 계정은 비밀값이 아닌 내부 참조 ID로 식별",
            "지급·회수는 문구 재확인과 멱등 키를 적용",
          ].map((principle) => (
            <div
              key={principle}
              className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600"
            >
              {principle}
            </div>
          ))}
        </div>
        <ToolCatalog
          appId={app.id}
          tools={tools}
          repoFullName={app.repoFullName}
          emptyTitle="IAP 관리 계약이 아직 없습니다"
          emptyDescription="IAP이 있는 게임은 테스트 계정 조회, 무료 지급, 회수, 구매 검증 오퍼레이션을 manifest에 선언합니다."
        />
      </WorkspaceSection>
    </div>
  );
}

function CommerceCard({
  label,
  value,
  date,
}: {
  label: string;
  value?: string | number | null;
  date?: Date | null;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-neutral-900">{value ?? "—"}</div>
      <div className="mt-1 text-[11px] text-neutral-400">
        {date ? `기준일 ${isoDate(date)}` : "데이터 없음"}
      </div>
    </div>
  );
}
