import { redirect } from "next/navigation";
import { parseMetricDay } from "@/lib/analytics/metric-day";
export default async function ReportRedirect({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
 const date = parseMetricDay((await searchParams).date); redirect(date ? `/?date=${date}` : "/");
}
