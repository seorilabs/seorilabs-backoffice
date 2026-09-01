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

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [appCount, issueCount, prCount, releaseCount, lastDelivery, allowUsers, fleetSummary, classificationQueue, legacyResolutionQueue] =
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

        <Card title="Fleet 등록과 중앙 DRAFT">
          <Row k="Repository 분류" v={`${fleetSummary.classificationCounts.PRODUCT_APP} 제품 · ${fleetSummary.classificationCounts.INFRA_REPO} 인프라 · ${fleetSummary.classificationCounts.PLATFORM_PRODUCER} 플랫폼 · ${fleetSummary.classificationCounts.EXCLUDED} 제외 - 보관 ${fleetSummary.classificationCounts.ARCHIVED} 포함`} />
          <Row k="미분류 / legacy" v={`${fleetSummary.classificationCounts.UNCLASSIFIED} / ${fleetSummary.classificationCounts.LEGACY_APP}`} />
          <Row k="중앙 앱 cohort" v={`${fleetSummary.activeApps}개`} />
          <Row k="DRAFT 생성 가능" v={`${fleetSummary.readyForDraft}개`} />
          <Row k="중앙 설정 있음" v={`${fleetSummary.alreadyConfigured}개`} />
          <Row k="입력 필요" v={`${fleetSummary.needsInput}개`} />
          <div className="mt-3 space-y-1 text-xs text-neutral-600">
            {Object.entries(fleetSummary.needsInputByReason).map(([reason, count]) => (
              <div key={reason} className="flex justify-between gap-3">
                <span className="break-all font-mono">{reason}</span>
                <span>{count}개</span>
              </div>
            ))}
            {fleetSummary.needsInput === 0 && <p>현재 입력이 필요한 중앙 cohort 앱이 없습니다.</p>}
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            이 자동화는 exact-SHA discovery에서 확인된 market만 새 DRAFT로 만들고, 검증된 기존 ACTIVE config의 source-only revision만 자동 활성화합니다. provider 변경, 법적 선언, 소유권·결제·심사·공개 승인은 수행하지 않습니다.
          </p>
        </Card>

        <Card title={`Repository 분류 입력 ${classificationQueue.length}건`}>
          <RepositoryClassificationQueue items={classificationQueue} />
          <p className="mt-3 text-xs text-neutral-500">
            저장 시 source를 추측하지 않고 최신 provider identity와 exact HEAD를 다시 읽습니다. fork는 제품 앱으로 승격할 수 없습니다.
          </p>
        </Card>

        <Card title={`Legacy 중앙 대체 검토 ${legacyResolutionQueue.length}건`}>
          <FleetLegacyResolutionQueue items={legacyResolutionQueue} />
        </Card>

        <Card title="Allowlist">
          <Row k="ENV ALLOWLIST_LOGINS" v={env.allowlistLogins().join(", ") || "(없음)"} />
          <Row k="허용된 사용자(DB)" v={allowUsers.map((u) => `@${u.login}`).join(", ") || "(없음)"} />
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
