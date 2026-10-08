import { getBoardApps } from "@/lib/queries";
import { Board } from "@/components/board/Board";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  const apps = await getBoardApps();

  return (
    <div className="px-4 py-6 sm:p-6">
      <h1 className="text-xl font-semibold">워크플로우 보드</h1>
      <p className="mt-1 mb-4 text-sm text-neutral-500">
        카드를 드래그해 단계를 이동합니다. 배포 성공 시 마켓등록→출시→운영은 자동 전이됩니다.
      </p>
      <Board apps={apps} />
    </div>
  );
}
