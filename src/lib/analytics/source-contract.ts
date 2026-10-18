import { z } from "zod";
import { unifiedMetricRowSchema } from "./unified-metrics";
import { parseMetricDay } from "./metric-day";

export const metricSourceSchema = z.enum(["apple-analytics", "play-reports", "admob"]);
export const analyticsConnectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  source: metricSourceSchema,
  enabled: z.boolean(), accountId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/),
  resourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,190}$/),
  credentialId: z.string().regex(/^(shared|app)\/[A-Za-z0-9._/-]{1,180}$/),
  timeZone: z.string().max(80).refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }),
}).strict().superRefine((connection, ctx) => {
  const credential = { "apple-analytics": "shared/apple/app-store-connect-uploader", "play-reports": "shared/google-play/publisher", admob: "shared/admob/reporting" };
  if (connection.credentialId !== credential[connection.source]) ctx.addIssue({ code: "custom", message: "등록된 공용 보고 identity의 logical ID를 사용해야 합니다." });
  if (connection.source === "apple-analytics" && (!/^\d+$/.test(connection.resourceId) || connection.timeZone !== "UTC")) ctx.addIssue({ code: "custom", message: "Apple 앱 ID와 UTC 보고 시간대가 필요합니다." });
  if (connection.source === "apple-analytics" && !/^[0-9a-f-]{36}$/i.test(connection.accountId)) ctx.addIssue({ code: "custom", message: "Apple 공개 issuer ID가 필요합니다." });
  if (connection.source === "play-reports" && !/^pubsite_prod_rev_\d+$/.test(connection.accountId)) ctx.addIssue({ code: "custom", message: "공식 Play 보고 bucket ID가 필요합니다." });
  if (connection.source === "admob" && (!/^pub-\d+$/.test(connection.accountId) || !/^ca-app-pub-\d+~\d+$/.test(connection.resourceId))) ctx.addIssue({ code: "custom", message: "AdMob 계정과 앱 공개 ID가 필요합니다." });
});
export type AnalyticsConnection = z.infer<typeof analyticsConnectionSchema>;
const day = z.string().refine((value) => parseMetricDay(value) !== null, "실제 달력일이 필요합니다.");
export const metricReportBatchSchema = z.object({
  appId: z.string().min(1), configRevisionId: z.string().min(1), connectionId: z.string().min(1),
  source: metricSourceSchema,
  accountId: z.string().min(1), resourceId: z.string().min(1), reportType: z.string().min(1).max(191),
  periodStart: day, periodEnd: day, grain: z.enum(["daily", "monthly", "cohort"]), timeZone: z.string(),
  processingDate: day, sourceVersion: z.string().min(1).max(191), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUri: z.string().min(1).max(2048), rows: z.array(unifiedMetricRowSchema).max(100_000),
}).strict().superRefine((batch, ctx) => {
  if (batch.periodEnd < batch.periodStart) ctx.addIssue({ code: "custom", message: "보고 기간 순서가 잘못됐습니다." });
  if (batch.grain === "daily" && batch.periodEnd !== batch.periodStart) ctx.addIssue({ code: "custom", message: "일별 자료는 하루에만 결속해야 합니다." });
});
export type MetricReportBatchInput = z.infer<typeof metricReportBatchSchema>;
