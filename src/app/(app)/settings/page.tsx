import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { fmtDateTime } from "@/lib/format";
import { SettingsActions } from "@/components/SettingsActions";
import { AdRevenueProbe } from "@/components/AdRevenueProbe";
import {
  visibleAppWhere,
  visibleIssueWhere,
  visiblePrWhere,
  visibleReleaseWhere,
} from "@/lib/domain/app-visibility";
import { getDesiredStateBackfillSummary } from "@/lib/control-plane/desired-state-backfill";
import { getRepositoryClassificationQueue } from "@/lib/control-plane/repository-classification-decision";
import { RepositoryClassificationQueue } from "@/components/RepositoryClassificationQueue";
import { getFleetLegacyResolutionQueue } from "@/lib/control-plane/fleet-legacy-resolution-queue";
import { FleetLegacyResolutionQueue } from "@/components/fleet/FleetLegacyResolutionQueue";
import { getFleetComplianceDraftQueue } from "@/lib/control-plane/fleet-compliance-draft-queue";
import { FleetComplianceDraftBatch } from "@/components/fleet/FleetComplianceDraftBatch";
import { GitHubBootstrapControls } from "@/components/fleet/GitHubBootstrapControls";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function SettingsPage() {
  const [appCount, issueCount, prCount, releaseCount, lastDelivery, allowUsers, fleetSummary, classificationQueue, legacyResolutionQueue, complianceDraftQueue] =
    await Promise.all([
      prisma.app.count({ where: visibleAppWhere }),
      prisma.issueMirror.count({ where: visibleIssueWhere }),
      prisma.pullRequestMirror.count({ where: visiblePrWhere }),
      prisma.releaseRecord.count({ where: visibleReleaseWhere }),
      prisma.webhookDelivery.findFirst({ orderBy: { receivedAt: "desc" } }),
      prisma.user.findMany({ where: { allowlisted: true }, select: { login: true } }),
      getDesiredStateBackfillSummary(),
      getRepositoryClassificationQueue(),
      getFleetLegacyResolutionQueue(),
      getFleetComplianceDraftQueue(),
    ]);

  return (
    <div className="px-4 py-6 sm:p-8">
      <h1 className="text-xl font-semibold">설정</h1>

      <section className="mt-6 max-w-xl space-y-4">
        <Card title="동기화 상태">
          <Row k="마지막 webhook 수신" v={lastDelivery ? `${fmtDateTime(lastDelivery.receivedAt)} (${lastDelivery.event})` : "없음"} />
          <Row k="앱/게임" v={`${appCount}개`} />
          <Row k="미러된 이슈 / PR" v={`${issueCount} / ${prCount}`} />
          <Row k="릴리스 레코드" v={`${releaseCount}`} />
        </Card>

        <Card title="작업">
          <SettingsActions />
        </Card>

        <Card title="GitHub 공통 관리 설정">
          <GitHubBootstrapControls />
        </Card>

        <Card title="앱 등록·설정 초안">
          <Row k="저장소 분류" v={`${fleetSummary.classificationCounts.PRODUCT_APP} 제품 · ${fleetSummary.classificationCounts.INFRA_REPO} 인프라 · ${fleetSummary.classificationCounts.PLATFORM_PRODUCER} 플랫폼 · ${fleetSummary.classificationCounts.EXCLUDED} 제외 - 보관 ${fleetSummary.classificationCounts.ARCHIVED} 포함`} />
          <Row k="미분류 / 기존 등록" v={`${fleetSummary.classificationCounts.UNCLASSIFIED} / ${fleetSummary.classificationCounts.LEGACY_APP}`} />
          <Row k="관리 중인 앱" v={`${fleetSummary.activeApps}개`} />
          <Row k="초안 생성 가능" v={`${fleetSummary.readyForDraft}개`} />
          <Row k="중앙 설정 있음" v={`${fleetSummary.alreadyConfigured}개`} />
          <Row k="입력 필요" v={`${fleetSummary.needsInput}개`} />
          <div className="mt-3 space-y-1 text-xs text-neutral-600">
            {Object.entries(fleetSummary.needsInputByReason).map(([reason, count]) => (
              <div key={reason} className="flex justify-between gap-3">
                <span className="break-all font-mono">{reason}</span>
                <span>{count}개</span>
              </div>
            ))}
            {fleetSummary.needsInput === 0 && <p>현재 입력이 필요한 앱이 없습니다.</p>}
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            소스에서 확인된 마켓만 설정 초안으로 만듭니다. 이미 검증된 설정은 소스 버전만 바뀐 경우에 한해 자동으로 적용합니다. 외부 서비스 변경이나 법적 선언, 소유권·결제·심사·공개 승인은 수행하지 않습니다.
          </p>
        </Card>

        <Card title={`저장소 분류 확인 ${classificationQueue.length}건`}>
          <RepositoryClassificationQueue items={classificationQueue} />
          <p className="mt-3 text-xs text-neutral-500">
            저장 전에 GitHub에서 계정과 최신 소스를 다시 확인합니다. 다른 저장소를 복제한 포크는 제품 앱으로 등록할 수 없습니다.
          </p>
        </Card>

        <Card title={`기존 설정 이관 검토 ${legacyResolutionQueue.length}건`}>
          <FleetLegacyResolutionQueue items={legacyResolutionQueue} />
        </Card>

        <Card title="접근 허용 사용자">
          <Row k="설정에 등록된 사용자" v={env.allowlistLogins().join(", ") || "(없음)"} />
          <Row k="허용된 사용자(DB)" v={allowUsers.map((u) => `@${u.login}`).join(", ") || "(없음)"} />
        </Card>
      </section>

      <section className="mt-4 max-w-5xl">
        <Card title={`앱별 정책·신고 정보 입력 ${complianceDraftQueue.length}건`}>
          <FleetComplianceDraftBatch items={complianceDraftQueue} />
        </Card>
      </section>

      <section className="mt-4 max-w-3xl">
        <Card title="광고/수익 지표 진단">
          <AdRevenueProbe />
        </Card>
      </section>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-neutral-700">{title}</h2>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-neutral-100 py-1.5 text-sm last:border-0">
      <span className="text-neutral-500">{k}</span>
      <span className="text-neutral-800">{v}</span>
    </div>
  );
}
