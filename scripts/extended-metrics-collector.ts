import { prisma } from "@/lib/prisma";
import { collectExtendedMetrics } from "@/lib/analytics/extended-collect";
collectExtendedMetrics().then((result) => {
  console.log(JSON.stringify(result));
  if (result.results.some((row) => row.status === "failed" || row.status === "partial")) process.exitCode = 1;
}).catch(() => { console.error("공급자 지표 수집에 실패했습니다. 수집 원장을 확인하세요."); process.exitCode = 1; }).finally(() => prisma.$disconnect());
