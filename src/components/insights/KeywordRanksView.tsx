import Link from "next/link";
import { keywordHistoryQuery } from "@/lib/market/keyword-history-query";
import type { HistoryParams } from "@/lib/market/keyword-history";
import { KeywordRankChart } from "./KeywordRankChart";

export async function KeywordRanksView({ params }: { params: HistoryParams }) {
  const data = await keywordHistoryQuery(params);
  return <div className="px-4 py-6 sm:p-8">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">검색 순위</h1><Link href="/feedback" className="text-sm text-blue-700">피드백·시장 →</Link></div>
    {data.app && data.history ? <KeywordRankChart apps={data.apps} app={data.app} selection={data.selection} history={data.history} today={data.today} /> : <section className="rounded-lg border border-neutral-200 bg-white p-4"><Link href={params.market === "google-play" ? "/feedback/keywords" : "/feedback/keywords?market=google-play"} className="text-blue-700">다른 마켓 조회</Link><p className="text-sm text-neutral-600">선택한 마켓에 추적 검색어가 설정된 앱이 없습니다. 앱 통합 관리에서 국가와 검색어를 설정하세요.</p><Link href="/apps" className="mt-3 inline-block text-sm text-blue-700">앱 목록 →</Link></section>}
  </div>;
}
