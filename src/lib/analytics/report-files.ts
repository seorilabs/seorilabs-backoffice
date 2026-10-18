import { parseMetricDay, metricDaysBetween } from "./metric-day";
import { unifiedMetricRowSchema, type UnifiedMetricRow, type UnifiedMetricKey } from "./unified-metrics";

/** 공식 UTF-8/UTF-16 파일의 따옴표·개행·빈 셀을 보존한다. 빈 숫자는 0으로 바꾸지 않는다. */
export function parseReportFile(bytes: Buffer, delimiter: "," | "\t"): Record<string, string>[] {
  if (bytes.length > 32 * 1024 * 1024) throw new Error("REPORT_FILE_TOO_LARGE");
  const text = (bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8")).replace(/^\uFEFF/, "");
  const lines: string[][] = [], row: string[] = [];
  let field = "", quoted = false;
  const push = () => { row.push(field); field = ""; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && char === delimiter) push();
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      push(); if (row.some(Boolean)) lines.push(row.splice(0)); else row.splice(0);
      if (lines.length > 100_001) throw new Error("REPORT_ROW_LIMIT");
    } else field += char;
  }
  if (quoted) throw new Error("REPORT_UNCLOSED_QUOTE");
  push(); if (row.some(Boolean)) lines.push(row);
  const header = lines.shift()?.map((key) => key.replaceAll("\u00a0", " ").trim());
  if (!header?.length || new Set(header).size !== header.length) throw new Error("REPORT_HEADER_INVALID");
  return lines.map((line) => {
    if (line.length !== header.length) throw new Error("REPORT_COLUMN_COUNT");
    return Object.fromEntries(header.map((key, index) => [key.replaceAll("\u00a0", " ").trim(), line[index]]));
  });
}

export const APPLE_REPORT_FIELDS: Record<string, Record<string, UnifiedMetricKey>> = {
  "App Downloads Standard": { Counts: "store_downloads" },
  "App Store Discovery and Engagement Standard": { Counts: "store_engagement", "Unique Counts": "unique_events" },
  "App Store Installation and Deletion Standard": { Counts: "install_delete_events", "Unique Devices": "unique_devices" },
  "App Sessions Standard": { Sessions: "sessions", "Total Session Duration": "session_seconds", "Unique Devices": "unique_devices" },
  "App Crashes": { Crashes: "crashes", "Unique Devices": "unique_devices" },
  "App Store Purchases Standard": { Purchases: "purchases", "Proceeds in USD": "purchase_proceeds", "Sales in USD": "purchase_sales" },
  "App Opt In": {},
  "App Store Subscription Event Report Standard": { Counts: "subscriptions" },
  "App Store Subscription State Report Standard": { Counts: "subscriptions" },
};
const appleDimensions = ["App Version", "Device", "Platform Version", "Territory", "Event", "Download Type", "Source Type", "Engagement Type", "Page Type", "App Download Date", "Purchase Type", "Content Apple Identifier", "Event Sub Type", "Event Grouping", "State Metric", "State Metric Grouping", "Subscription Identifier", "Subscription Group Identifier", "Offer Type", "Offer ID", "Cancellation Reason"];
export function reportNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "" || ["*", "—", "-"].includes(raw.trim())) return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(raw.trim())) throw new Error("REPORT_NUMBER_INVALID");
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error("REPORT_NUMBER_INVALID");
  return value;
}
export interface DatedMetricRow { day: string; row: UnifiedMetricRow }
export function appleReportRows(reportType: string, records: Record<string, string>[], appId: string, processingDate: string): DatedMetricRow[] {
  const fields = APPLE_REPORT_FIELDS[reportType];
  if (!fields) throw new Error("REPORT_TYPE_UNSUPPORTED");
  return records.flatMap((record) => {
    if (record["App Apple Identifier"] !== appId) throw new Error("REPORT_APP_MISMATCH");
    const day = parseMetricDay(record.Date ?? record["Event Date"]);
    if (!day || !parseMetricDay(processingDate)) throw new Error("REPORT_DATE_INVALID");
    const dimensions = Object.fromEntries(appleDimensions.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
    const cells = Object.entries(fields).map(([column, metric]) => {
      if (!(column in record)) throw new Error(`REPORT_FIELD_MISSING:${column}`);
      const value = reportNumber(record[column]);
      if (metric === "store_engagement") metric = ({ Impression: "store_impressions", "Page view": "store_page_views", Tap: "store_taps" } as const)[record.Event] ?? metric;
      if (metric === "install_delete_events") metric = ({ Install: "device_installs", Delete: "device_uninstalls" } as const)[record.Event] ?? metric;
      return { day, row: unifiedMetricRowSchema.parse({ metric, value, dimensions, currency: column.endsWith(" in USD") ? "USD" : null,
        state: value === null ? "not_landed" : value === 0 ? "empty" : "observed",
        valueStatus: metricDaysBetween(processingDate, day) >= 2 ? "analyzable" : "provisional" }) };
    });
    if (reportType === "App Opt In") {
      if (!("Users Opting-In" in record) || !("Downloading Users" in record)) throw new Error("REPORT_OPT_IN_FIELDS_MISSING");
      const numerator = reportNumber(record["Users Opting-In"]), denominator = reportNumber(record["Downloading Users"]);
      cells.push({ day, row: unifiedMetricRowSchema.parse({ metric: "opt_in", value: numerator !== null && denominator !== null && denominator > 0 ? 100 * numerator / denominator : null, numerator, denominator, dimensions, currency: null,
        state: numerator !== null && denominator !== null ? denominator > 0 ? numerator === 0 ? "empty" : "observed" : "not_applicable" : "not_landed", valueStatus: metricDaysBetween(processingDate, day) >= 2 ? "analyzable" : "provisional" }) });
    }
    return cells;
  });
}

export function playInstallRows(records: Record<string, string>[], packageName: string): DatedMetricRow[] {
  const fields: Record<string, UnifiedMetricKey> = { "Daily Device Installs": "device_installs", "Daily Device Uninstalls": "device_uninstalls", "Daily User Installs": "user_installs", "Daily User Uninstalls": "user_uninstalls" };
  return records.flatMap((record) => {
    if (record["Package Name"] !== packageName) throw new Error("REPORT_APP_MISMATCH");
    const day = parseMetricDay(record.Date);
    if (!day) throw new Error("REPORT_DATE_INVALID");
    const present = Object.entries(fields).filter(([column]) => column in record);
    if (!present.length) throw new Error("REPORT_FIELD_MISSING:installs");
    return present.map(([column, metric]) => {
      const value = reportNumber(record[column]);
      const dimensions = Object.fromEntries(Object.entries(record).filter(([key]) => ["Country", "Device", "App Version Code", "Android OS Version", "Carrier", "Language"].includes(key)));
      return { day, row: unifiedMetricRowSchema.parse({ metric, value, dimensions, currency: null, state: value === null ? "not_landed" : value === 0 ? "empty" : "observed", valueStatus: "analyzable" }) };
    });
  });
}
