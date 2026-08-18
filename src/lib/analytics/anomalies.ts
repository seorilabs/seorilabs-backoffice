import { recordIncident, recoverIncident } from "@/lib/notifications/incidents";

export interface AnomalyMetricRow {
  date: Date;
  dau: number;
  adCompletions: number;
  networkAdImpressions: number;
}

export interface MetricAnomaly {
  kind: "dau_drop" | "ad_delivery_gap";
  severity: "warning" | "critical";
  summary: string;
  evidence: Record<string, string | number>;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function detectMetricAnomalies(displayName: string, rowsDesc: AnomalyMetricRow[]): MetricAnomaly[] {
  if (rowsDesc.length < 6) return [];
  const latest = rowsDesc[0];
  const baselineRows = rowsDesc.slice(1, 8);
  const baselineDau = median(baselineRows.map((row) => row.dau));
  const result: MetricAnomaly[] = [];
  if (baselineDau >= 20 && latest.dau <= baselineDau * 0.4) {
    result.push({
      kind: "dau_drop",
      severity: "critical",
      summary: `${displayName} DAU 급락`,
      evidence: { latestDau: latest.dau, baselineMedianDau: baselineDau, dropPct: Math.round((1 - latest.dau / baselineDau) * 100) },
    });
  }
  if (latest.adCompletions >= 20 && latest.networkAdImpressions === 0) {
    result.push({
      kind: "ad_delivery_gap",
      severity: "warning",
      summary: `${displayName} 광고 완료 대비 네트워크 노출 0건`,
      evidence: { adCompletions: latest.adCompletions, networkAdImpressions: latest.networkAdImpressions },
    });
  }
  return result;
}

export async function reconcileMetricAnomalies(input: {
  appId: string;
  appSlug: string;
  displayName: string;
  rowsDesc: AnomalyMetricRow[];
}) {
  if (input.rowsDesc.length < 6) return { detected: 0, recovered: 0 };
  const latest = input.rowsDesc[0];
  const anomalies = detectMetricAnomalies(input.displayName, input.rowsDesc);
  const detectedKinds = new Set(anomalies.map((item) => item.kind));
  for (const anomaly of anomalies) {
    await recordIncident({
      source: "metrics",
      kind: anomaly.kind,
      severity: anomaly.severity,
      summary: anomaly.summary,
      signalId: `${input.appSlug}:${latest.date.toISOString().slice(0, 10)}:${anomaly.kind}`,
      detectedAt: latest.date,
      appId: input.appId,
      evidence: anomaly.evidence,
      destinationKey: "ops-alerts",
    });
  }
  let recovered = 0;
  for (const kind of ["dau_drop", "ad_delivery_gap"] as const) {
    if (detectedKinds.has(kind)) continue;
    const incident = await recoverIncident({
      source: "metrics",
      kind,
      appId: input.appId,
      signalId: `${input.appSlug}:${latest.date.toISOString().slice(0, 10)}:${kind}:recovered`,
      recoveredAt: latest.date,
    });
    if (incident) recovered++;
  }
  return { detected: anomalies.length, recovered };
}
