import type { ConsoleDailyMetric } from "../console-source";
import type { MetricCollectionPoint } from "@/lib/insights/metric-collection-facts";

export function consoleMetricPoints(slug: string, miniAppId: number, days: ConsoleDailyMetric[], displayName = slug): MetricCollectionPoint[] {
  return days.map(day => ({ key: `${slug}#${miniAppId}`, label: `${displayName} (${miniAppId})`, day: day.date,
    metrics: {
      dau: { label: "활성 사용자", value: day.dau ?? null, unit: "명" },
      iaa: { label: "광고 추정 수익", value: day.iaaEarningKrw ?? null, unit: "원" },
      iap: { label: "결제 거래액", value: day.iapTrxAmountKrw ?? null, unit: "원" },
    },
  }));
}
