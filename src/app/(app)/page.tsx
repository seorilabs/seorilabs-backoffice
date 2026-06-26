import Link from "next/link";
import { getBoardApps } from "@/lib/queries";
import { STAGES, STAGE_KO } from "@/lib/domain/lifecycle";
import { StageBadge, TypeBadge, MarketDots, Pill, StatusBadge } from "@/components/badges";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const apps = await getBoardApps();
  const totals = {
    p1: apps.reduce((n, a) => n + a.p1, 0),
    p2: apps.reduce((n, a) => n + a.p2, 0),
    issues: apps.reduce((n, a) => n + a.openIssues, 0),
    prs: apps.reduce((n, a) => n + a.openPrs, 0),
  };

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">대시보드</h1>
      <p className="mt-1 text-sm text-neutral-500">
        앱/게임 {apps.length}개 · 전체 라이프사이클 현황
      </p>

      {/* 단계별 카운트 */}
      <div className="mt-6 grid grid-cols-6 gap-3">
        {STAGES.map((s) => {
          const count = apps.filter((a) => a.stage === s).length;
          return (
            <Link
              key={s}
              href="/board"
              className="rounded-lg border border-neutral-200 bg-white p-3 text-center hover:border-neutral-400"
            >
              <div className="text-2xl font-semibold">{count}</div>
              <div className="text-xs text-neutral-500">{STAGE_KO[s]}</div>
            </Link>
          );
        })}
      </div>

      {/* 집계 배지 */}
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        <Pill tone="red">열린 P1 {totals.p1}</Pill>
        <Pill tone="amber">P2 {totals.p2}</Pill>
        <Pill tone="blue">열린 이슈 {totals.issues}</Pill>
        <Pill tone="neutral">열린 PR {totals.prs}</Pill>
      </div>

      {/* 앱 카드 그리드 */}
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {apps.map((a) => (
          <Link
            key={a.id}
            href={`/apps/${a.id}`}
            className="rounded-lg border border-neutral-200 bg-white p-4 transition hover:border-neutral-400"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="font-medium">{a.displayName}</div>
              <StageBadge stage={a.stage} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <TypeBadge type={a.type} engine={a.engine} />
              <StatusBadge status={a.status} />
              {a.blocked && <Pill tone="red">blocked</Pill>}
              {a.approvalWaiting && <Pill tone="amber">승인대기</Pill>}
              {a.needsConfig && <Pill tone="neutral">확정 필요</Pill>}
            </div>
            <div className="mt-3">
              <MarketDots targets={a.marketTargets} status={a.marketStatus} />
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-neutral-500">
              <span>
                이슈 {a.openIssues} · PR {a.openPrs}
                {a.p1 > 0 && <span className="ml-1 text-red-600">P1 {a.p1}</span>}
              </span>
              <span>
                {a.latestRelease
                  ? `rel ${a.latestRelease.version} ${fmtDate(a.latestRelease.deployedAt)}`
                  : "—"}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
