import { notFound } from "next/navigation";

import { AiAgentPanel } from "@/components/AiAgentPanel";
import { EmptyState, Panel, WorkspaceSection } from "@/components/app-ops/WorkspaceUi";
import { Pill, PriorityTag } from "@/components/badges";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import { env } from "@/lib/env";
import { fmtDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export default async function AppDevelopmentPage({
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
      transitions: { orderBy: { createdAt: "desc" }, take: 30 },
    },
  });
  if (!app) notFound();
  const openIssues = app.issues.filter((issue) => issue.state === "OPEN");
  const aiEnabled = env.geminiChatConfigured();
  const drafts = aiEnabled
    ? await prisma.aiDraft.findMany({
        where: { appId: app.id, status: "DRAFT" },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          kind: true,
          title: true,
          issueNumber: true,
          outputText: true,
          model: true,
        },
      })
    : [];

  return (
    <div className="space-y-8">
      <WorkspaceSection
        title="AI 에이전트"
        description="현재 앱과 이슈를 기준으로 검토 가능한 초안을 생성합니다."
      >
        <Panel>
          <AiAgentPanel
            appId={app.id}
            aiEnabled={aiEnabled}
            openIssues={openIssues.map((issue) => ({
              number: issue.number,
              title: issue.title,
            }))}
            initialDrafts={drafts}
          />
        </Panel>
      </WorkspaceSection>

      <WorkspaceSection
        title={`이슈 · ${openIssues.length} open`}
        description="GitHub 이슈 미러입니다. 변경은 GitHub에서 수행하고 webhook으로 동기화됩니다."
      >
        {app.issues.length > 0 ? (
          <Panel>
            <div className="divide-y divide-neutral-100">
              {app.issues.slice(0, 50).map((issue) => (
                <div key={issue.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  {issue.priority && <PriorityTag priority={issue.priority} />}
                  <a
                    href={`https://github.com/${issue.repoFullName}/issues/${issue.number}`}
                    target="_blank"
                    rel="noreferrer"
                    className={`min-w-0 flex-1 hover:underline ${
                      issue.state === "CLOSED" ? "text-neutral-400 line-through" : ""
                    }`}
                  >
                    #{issue.number} {issue.title}
                  </a>
                  {issue.isAutopilot && <Pill tone="blue">autopilot</Pill>}
                  {issue.hasEvidence && <Pill tone="green">evidence</Pill>}
                </div>
              ))}
            </div>
          </Panel>
        ) : (
          <EmptyState title="이슈가 없습니다">GitHub 동기화 상태를 확인하세요.</EmptyState>
        )}
      </WorkspaceSection>

      <WorkspaceSection title="Pull Requests">
        {app.pullRequests.length > 0 ? (
          <Panel>
            <div className="divide-y divide-neutral-100">
              {app.pullRequests.map((pr) => (
                <div key={pr.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <a
                    href={`https://github.com/${pr.repoFullName}/pull/${pr.number}`}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate hover:underline"
                  >
                    #{pr.number} {pr.title}
                  </a>
                  <Pill tone={pr.state === "MERGED" ? "green" : pr.state === "OPEN" ? "blue" : "amber"}>
                    {pr.state}
                  </Pill>
                </div>
              ))}
            </div>
          </Panel>
        ) : (
          <EmptyState title="Pull Request가 없습니다">GitHub 동기화 상태를 확인하세요.</EmptyState>
        )}
      </WorkspaceSection>

      <WorkspaceSection title="라이프사이클 전이 이력">
        <Panel>
          <div className="divide-y divide-neutral-100">
            {app.transitions.map((transition) => (
              <div
                key={transition.id}
                className="flex items-center justify-between gap-4 py-2 text-sm"
              >
                <span>
                  {transition.fromStage ? STAGE_KO[transition.fromStage] : "—"} →{" "}
                  {STAGE_KO[transition.toStage]}
                  <span className="ml-1 text-xs text-neutral-400">
                    {transition.source.toLowerCase()}
                    {transition.actorLogin ? ` · @${transition.actorLogin}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-neutral-400">
                  {fmtDateTime(transition.createdAt)}
                </span>
              </div>
            ))}
            {app.transitions.length === 0 && (
              <div className="py-4 text-center text-sm text-neutral-400">데이터 없음</div>
            )}
          </div>
        </Panel>
      </WorkspaceSection>
    </div>
  );
}
