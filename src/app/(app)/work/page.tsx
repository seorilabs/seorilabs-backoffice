import Link from "next/link";
import { OperationsOverview } from "@/components/insights/OperationsOverview";
export const dynamic = "force-dynamic";
export default function WorkPage() {
  return (
    <div className="px-4 py-6 sm:p-8">
      <h1 className="text-xl font-semibold">해야 할 일</h1>
      <p className="mt-1 text-sm text-neutral-500">
        긴급 작업을 확인하고 이슈·승인·개발 단계로 이어갑니다.
      </p>
      <nav className="my-5 flex flex-wrap gap-2" aria-label="작업 영역">
        {[
          ["issues", "이슈"],
          ["approvals", "승인 대기"],
          ["board", "개발·출시 단계"],
          ["plan", "기획 입력"],
        ].map(([key, label]) => (
          <Link
            key={key}
            href={`/work/${key}`}
            className="rounded border bg-white px-3 py-2 text-sm"
          >
            {label}
          </Link>
        ))}
        <Link href="/settings/automations" className="rounded border bg-white px-3 py-2 text-sm">
          자동 실행 관리
        </Link>
      </nav>
      <OperationsOverview />
    </div>
  );
}
