import Link from "next/link";

export default function NotFound() {
  return (
    <div className="px-4 py-12 text-center sm:px-8">
      <h1 className="text-xl font-semibold">페이지를 찾을 수 없습니다</h1>
      <p className="mt-2 text-sm text-neutral-500">주소를 확인하거나 앱 목록에서 다시 선택해 주세요.</p>
      <Link href="/apps" className="mt-6 inline-block rounded bg-neutral-900 px-4 py-2 text-sm text-white">
        앱 목록으로
      </Link>
    </div>
  );
}
