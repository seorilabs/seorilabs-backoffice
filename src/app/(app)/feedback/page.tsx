import { FeedbackView } from "@/components/insights/FeedbackView";
import Link from "next/link";
export const dynamic = "force-dynamic";
export default function FeedbackPage() {
  return (
    <div className="px-4 py-6 sm:p-8">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold">피드백·시장</h1>
        <Link href="/settings/health" className="text-sm text-blue-700">
          수집 상태 →
        </Link>
      </div>
      <FeedbackView />
    </div>
  );
}
