import { KeywordRanksView } from "@/components/insights/KeywordRanksView";
import type { HistoryParams } from "@/lib/market/keyword-history";
export const dynamic = "force-dynamic";
export default async function KeywordPage({ searchParams }: { searchParams: Promise<HistoryParams> }) {
  return <KeywordRanksView params={await searchParams} />;
}
