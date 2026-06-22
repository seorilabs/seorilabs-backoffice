import { prisma } from "@/lib/prisma";
import { PlanForm } from "@/components/PlanForm";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const apps = await prisma.app.findMany({
    select: { repoFullName: true, displayName: true },
    orderBy: { displayName: "asc" },
  });

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">기획 입력</h1>
      <p className="mt-1 mb-6 text-sm text-neutral-500">
        입력 내용은 GitHub Issue 로 생성되어(seorilabs_execution_task 필드 매핑) 미러에 수렴합니다.
        로컬 Claude Code 의 <code>gh issue create</code> 와 동일 경로입니다.
      </p>
      {apps.length === 0 ? (
        <p className="text-sm text-neutral-400">
          등록된 앱이 없습니다. 설정에서 레지스트리 시드를 먼저 실행하세요.
        </p>
      ) : (
        <PlanForm apps={apps} />
      )}
    </div>
  );
}
