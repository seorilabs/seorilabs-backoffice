import { requireHuman } from "@/lib/supervisor/auth";
import { SupervisorInbox } from "./supervisor-inbox";
export const dynamic = "force-dynamic";
export default async function SupervisorPage() {
  await requireHuman();
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:p-8">
      <h1 className="text-2xl font-semibold">대표 에이전트</h1>
      <p className="mt-2 text-sm text-neutral-600">
        근거와 변경 범위를 확인하고 실행할 작업을 고릅니다.
      </p>
      <SupervisorInbox />
    </main>
  );
}
