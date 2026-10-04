import { kstDateTimeShort } from "@/lib/format/kst";
import { DiscordAccountConnection } from "@/components/DiscordAccountConnection";
import { prisma } from "@/lib/prisma";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { approvalIssueWhere } from "@/lib/domain/app-visibility";
import { PriorityTag } from "@/components/badges";
import { ApprovalControls } from "@/components/ApprovalControls";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const deployments = await prisma.deploymentApproval.findMany({ where: { OR: [{ providerState: "WAITING" }, { actionState: { in: ["SENDING", "UNKNOWN"] } }] }, orderBy: { waitingSince: "asc" } });
  const open = await prisma.issueMirror.findMany({
    where: { ...approvalIssueWhere, state: "OPEN" },
    orderBy: [{ priority: "asc" }, { ghUpdatedAt: "desc" }],
    select: {
      id: true,
      number: true,
      title: true,
      repoFullName: true,
      priority: true,
      labels: true,
    },
  });

  const planning = open.filter((i) => hasApproval(asStringArray(i.labels), "planning"));
  const release = open.filter((i) => hasApproval(asStringArray(i.labels), "release"));

  return (
    <div className="px-4 py-6 sm:p-8">
      <h1 className="text-xl font-semibold">승인 대기</h1>
      <p className="mt-1 mb-6 text-sm text-neutral-500">
        플랫폼 배포와 이슈의 승인 대기를 확인합니다.
      </p>

      <section className="mb-8">
        <h2 className="font-semibold">플랫폼 배포 승인 ({deployments.length})</h2>
        <p className="text-sm text-neutral-500">GitHub 환경 승인입니다. 승인과 배포 성공은 별도로 확인합니다.</p>
        <DiscordAccountConnection />
        {deployments.length === 0 && <p className="text-sm">저장된 대기 항목 없음 — 조회 장애 여부는 #ops-alerts에서 확인하세요.</p>}
        {deployments.map(row => <div key={row.id} className="my-2 rounded-lg border border-neutral-200 bg-white p-3 text-sm">
          <a className="underline" href={`https://github.com/${row.repository}/actions/runs/${row.runId}/attempts/${row.runAttempt}`} target="_blank" rel="noreferrer">{row.environment} · {row.workflow} #{row.runNumber} · 재실행 {row.runAttempt}</a>
          <p className="break-all">소스 SHA: {row.sourceSha}</p>
          <p>대기 관측: {kstDateTimeShort(row.waitingSince)} · 최근 조회: {kstDateTimeShort(row.observedAt)}</p>
          {row.observationError && <p role="alert">{row.observationError}</p>}
          {["SENDING", "UNKNOWN"].includes(row.actionState) && <p>처리 결과 확인 필요 — 자동 재전송 중단</p>}
        </div>)}
      </section>
      <Section title="기획 승인 (approval:planning)" gate="planning" issues={planning} />
      <Section title="릴리스 승인 (approval:release)" gate="release" issues={release} />
    </div>
  );
}

function Section({
  title,
  gate,
  issues,
}: {
  title: string;
  gate: "planning" | "release";
  issues: { id: string; number: number; title: string; repoFullName: string; priority: string | null }[];
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-semibold text-neutral-700">
        {title} <span className="text-neutral-400">({issues.length})</span>
      </h2>
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        {issues.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-neutral-400">대기 중인 항목 없음</div>
        )}
        {issues.map((i) => (
          <div
            key={i.id}
            className="flex items-center justify-between gap-3 border-b border-neutral-100 px-3 py-2.5 last:border-0"
          >
            <div className="flex min-w-0 items-center gap-2">
              {i.priority && <PriorityTag priority={i.priority} />}
              <a
                href={`https://github.com/${i.repoFullName}/issues/${i.number}`}
                target="_blank"
                rel="noreferrer"
                className="truncate text-sm hover:underline"
              >
                <span className="text-neutral-400">{i.repoFullName.replace("seorilabs/", "")} #{i.number}</span>{" "}
                {i.title}
              </a>
            </div>
            <ApprovalControls issueId={i.id} gate={gate} />
          </div>
        ))}
      </div>
    </section>
  );
}
