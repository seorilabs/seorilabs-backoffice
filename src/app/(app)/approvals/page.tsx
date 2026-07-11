import { prisma } from "@/lib/prisma";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { visibleIssueWhere } from "@/lib/domain/app-visibility";
import { PriorityTag } from "@/components/badges";
import { ApprovalControls } from "@/components/ApprovalControls";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const open = await prisma.issueMirror.findMany({
    where: { ...visibleIssueWhere, state: "OPEN" },
    orderBy: [{ priority: "asc" }, { ghUpdatedAt: "desc" }],
    take: 500,
  });

  const planning = open.filter((i) => hasApproval(asStringArray(i.labels), "planning"));
  const release = open.filter((i) => hasApproval(asStringArray(i.labels), "release"));

  return (
    <div className="px-4 py-6 sm:p-8">
      <h1 className="text-xl font-semibold">승인 대기</h1>
      <p className="mt-1 mb-6 text-sm text-neutral-500">
        지금 내 승인이 필요한 이슈. 승인 처리 시 GitHub 라벨이 제거되고 사유가 코멘트로 남습니다.
      </p>

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
