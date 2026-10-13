"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
export default function ErrorPage({ reset }: { reset: () => void }) {
  const params = useSearchParams().toString();
  const previousQuery = useRef(params);
  useEffect(() => {
    if (previousQuery.current !== params) { previousQuery.current = params; reset(); }
  }, [params, reset]);
  const query = new URLSearchParams(params);
  query.set("days", "7");
  // 새 요청으로 다시 읽으며, 뒤로가기·앞으로가기는 해당 URL의 오류 상태를 초기화한다.
  return <div className="px-4 py-6 sm:p-8"><h1 className="mb-5 text-xl font-semibold">검색 순위</h1><div className="rounded-lg border border-neutral-200 bg-white p-4"><p role="alert" className="mb-3 text-sm">기록을 불러오지 못했습니다. DB 연결을 확인하거나 조회 기간을 줄여 다시 시도하세요.</p><div className="flex flex-wrap gap-3"><a href={`/feedback/keywords?${params}`} className="inline-flex min-h-11 items-center rounded border px-3 py-2 text-sm">다시 시도</a><a href={`/feedback/keywords?${query}`} className="py-2 text-sm text-blue-700">7일로 조회</a><Link href="/settings/health" className="py-2 text-sm text-blue-700">수집 상태 →</Link></div></div></div>;
}
