"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
export default function ErrorPage({ reset }: { reset: () => void }) {
  const query = new URLSearchParams(useSearchParams().toString());
  query.set("days", "7");
  // 같은 경로의 검색 매개변수만 바꾸면 오류 경계가 남으므로 새 페이지 요청으로 복구한다.
  return <div className="px-4 py-6 sm:p-8"><h1 className="mb-5 text-xl font-semibold">검색 순위</h1><div className="rounded-lg border border-neutral-200 bg-white p-4"><p role="alert" className="mb-3 text-sm">기록을 불러오지 못했습니다. DB 연결을 확인하거나 조회 기간을 줄여 다시 시도하세요.</p><div className="flex flex-wrap gap-3"><button type="button" onClick={() => reset()} className="min-h-11 rounded border px-3 py-2 text-sm">다시 시도</button><a href={`/feedback/keywords?${query}`} className="py-2 text-sm text-blue-700">7일로 조회</a><Link href="/settings/health" className="py-2 text-sm text-blue-700">수집 상태 →</Link></div></div></div>;
}
