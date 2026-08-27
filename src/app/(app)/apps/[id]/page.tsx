import { notFound } from "next/navigation";

import { CapabilityGrid, Panel, WorkspaceSection } from "@/components/app-ops/WorkspaceUi";
import { MetricCards, type MetricDaily } from "@/components/analytics/MetricPanels";
import { StatusControl } from "@/components/StatusControl";
import { PlayInternalTestControl } from "@/components/PlayInternalTestControl";
import { hasEvidence } from "@/lib/domain/labels";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { STATUS_KO } from "@/lib/domain/lifecycle";
import { asStringArray, fmtDate } from "@/lib/format";
import { resolveGa4Target } from "@/lib/ga4/datasets";
import { parseAppOpsManifest } from "@/lib/app-ops/manifest";
import { buildAppWorkspaceTabs } from "@/lib/app-ops/workspace";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function AppOverview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const app = await prisma.app.findFirst({
    where: { id, ...visibleAppWhere },
    include: {
      issues: { orderBy: [{ state: "asc" }, { priority: "asc" }], take: 100 },
      pullRequests: { orderBy: { ghUpdatedAt: "desc" }, take: 50 },
      releases: { orderBy: { updatedAt: "desc" }, take: 30 },
    },
  });
  if (!app) notFound();

  const openIssues = app.issues.filter((issue) => issue.state === "OPEN");
  const targets = asStringArray(app.marketTargets);
  const tabs = buildAppWorkspaceTabs(app);
  const { manifest } = parseAppOpsManifest(app.opsManifest);
  const latestMetric = resolveGa4Target(app)
    ? ((await prisma.appMetricDaily.findFirst({
        where: { appId: app.id },
        orderBy: { date: "desc" },
      })) as MetricDaily | null)
    : null;

  return (
    <div className="space-y-8">
      <WorkspaceSection
        title="관리 현황"
        description={
          manifest?.summary ??
          "앱의 제품 지표, 런타임 오퍼레이션, 개발과 릴리스를 한 워크스페이스에서 관리합니다."
        }
      >
        <CapabilityGrid tabs={tabs} />
      </WorkspaceSection>

      <WorkspaceSection title="앱 구성">
        <Panel>
          <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <Meta k="마켓" v={targets.join(", ") || "미정"} />
            <Meta
              k="Play 패키지"
              v={app.playPackage}
              needs={targets.includes("play") && !app.playPackage}
            />
            <Meta
              k="iOS 번들"
              v={app.iosBundle}
              needs={targets.includes("appstore") && !app.iosBundle}
            />
            <Meta k="Firebase" v={app.firebaseProject} />
            <Meta
              k="AIT"
              v={app.aitAppName}
              needs={targets.includes("ait") && !app.aitAppName}
            />
            <Meta k="운영 상태" v={STATUS_KO[app.status]} />
            <Meta
              k="관리툴 계약"
              v={manifest ? `v${manifest.version} · ${manifest.tools.length}개 도구` : null}
            />
            <Meta k="구성 동기화" v={fmtDate(app.configSyncedAt)} />
          </div>
          {targets.includes("play") && (
            <div className="mt-4 border-t border-neutral-100 pt-3">
              <PlayInternalTestControl appId={app.id} url={app.playInternalTestUrl} />
            </div>
          )}
          <div className="mt-4 border-t border-neutral-100 pt-3">
            <StatusControl appId={app.id} status={app.status} />
          </div>
        </Panel>
      </WorkspaceSection>

      {app.currentStage === "LIVEOPS" && (
        <WorkspaceSection
          title="지속개선 루프"
          description="지표 근거가 있는 가설부터 구현, 릴리스, 재측정까지의 현재 상태입니다."
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MiniCol
              title="가설중"
              items={openIssues
                .filter((issue) => hasEvidence(asStringArray(issue.labels)))
                .map((issue) => `#${issue.number} ${issue.title}`)}
            />
            <MiniCol
              title="구현중"
              items={app.pullRequests
                .filter((pr) => pr.state === "OPEN")
                .map((pr) => `#${pr.number} ${pr.title}`)}
            />
            <MiniCol
              title="릴리스 대기"
              items={app.pullRequests
                .filter((pr) => pr.state === "MERGED")
                .slice(0, 8)
                .map((pr) => `#${pr.number} ${pr.title}`)}
            />
            <MiniCol
              title="재측정 대기"
              items={app.releases
                .filter((release) => release.status === "SUCCEEDED")
                .slice(0, 8)
                .map((release) => `${release.market} ${release.version}`)}
            />
          </div>
        </WorkspaceSection>
      )}

      {latestMetric && (
        <WorkspaceSection
          title="최신 핵심 지표"
          description={`기준일 ${latestMetric.date.toISOString().slice(0, 10)}`}
        >
          <MetricCards latest={latestMetric} />
        </WorkspaceSection>
      )}
    </div>
  );
}

function Meta({ k, v, needs }: { k: string; v?: string | null; needs?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-neutral-500">{k}</span>
      <span className="text-right text-neutral-800">
        {v ?? (needs ? <span className="text-amber-600">확정 필요</span> : "—")}
      </span>
    </div>
  );
}

function MiniCol({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-neutral-600">
        <span>{title}</span>
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-500">
          {items.length}
        </span>
      </div>
      <div className="space-y-1">
        {items.slice(0, 6).map((item) => (
          <div key={item} className="truncate rounded bg-neutral-50 px-2 py-1 text-xs text-neutral-700">
            {item}
          </div>
        ))}
        {items.length === 0 && <div className="py-2 text-center text-xs text-neutral-400">—</div>}
      </div>
    </div>
  );
}
