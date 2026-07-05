import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { enqueueVaultWrite } from "@/lib/vault/write-core";
import { notify, esc, telegramConfigured } from "@/lib/telegram/client";
import { resolveGa4Target, latestClosedDay, isoDate } from "@/lib/ga4/datasets";
import { visibleAppWhere } from "@/lib/domain/app-visibility";

// 야간(22:00 KST) 지표 보고서: 앱별 상세 노트를 Obsidian(프로젝트/지표)에 큐잉하고,
// 전체 요약을 Telegram 으로 발송. BigQuery 를 직접 치지 않고 AppMetricDaily 스냅샷만 읽는다.
// vault-writer 가 파일명 앞에 처리일(KST)을 붙이므로 title 에는 날짜를 넣지 않는다.

const REPORT_FOLDER = "프로젝트/지표";
const RECENT_DAYS = 14;

export interface MetricRow {
  date: Date;
  dau: number;
  newUsers: number;
  d1Pct: number | null;
  d3Pct: number | null;
  d7Pct: number | null;
  engagedUsers: number;
  avgEngageSec: number | null;
  adEventUsers: number;
  adImpressions: number;
}

export interface ReportResult {
  refDate: string; // 기준일(D-1)
  apps: number; // 보고서 생성된 앱 수
  enqueued: number; // Obsidian 쓰기 큐 건수
  telegramSent: boolean;
  skipped: string[]; // 스냅샷 없어 제외된 앱 slug
}

const pct = (v: number | null): string => (v == null ? "—" : `${v}%`);
const numOrDash = (v: number | null): string => (v == null ? "—" : String(v));

/** 앱별 상세 보고서 마크다운. rowsDesc 는 최신순(내림차순). */
export function buildAppReportMd(
  displayName: string,
  rowsDesc: MetricRow[],
  generatedOn: string,
): string {
  const latest = rowsDesc[0];
  const day = (d: Date): string => isoDate(d);
  const lines = [
    `# ${displayName} 지표`,
    "",
    `> 기준일 ${day(latest.date)} (D-1 확정) · 생성 ${generatedOn}`,
    "",
    `## 핵심 지표 (${day(latest.date)})`,
    `- DAU ${latest.dau}`,
    `- 신규(first_visit) ${latest.newUsers}`,
    `- D1 잔존율 ${pct(latest.d1Pct)} · D3 ${pct(latest.d3Pct)} · D7 ${pct(latest.d7Pct)}`,
    `- engagement ${latest.engagedUsers}명 · 평균 ${numOrDash(latest.avgEngageSec)}초`,
    `- 광고 노출 ${latest.adImpressions} · 고유 ${latest.adEventUsers}명`,
    "",
    `## 최근 ${rowsDesc.length}일 추이`,
    `| 날짜 | DAU | 신규 | D1 | D7 | 광고노출 |`,
    `| --- | ---: | ---: | ---: | ---: | ---: |`,
    ...rowsDesc.map(
      (r) =>
        `| ${day(r.date)} | ${r.dau} | ${r.newUsers} | ${pct(r.d1Pct)} | ${pct(r.d7Pct)} | ${r.adImpressions} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

/** Telegram 요약 한 줄(HTML). */
export function summaryLine(displayName: string, latest: MetricRow): string {
  return `<b>${esc(displayName)}</b> DAU ${latest.dau} · 신규 ${latest.newUsers} · D7 ${pct(latest.d7Pct)} · 광고 ${latest.adImpressions}`;
}

export async function sendMetricsReport(now: Date): Promise<ReportResult> {
  const end = latestClosedDay(now);
  const generatedOn = isoDate(now);

  const apps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: { id: true, slug: true, displayName: true, firebaseProject: true, ga4Dataset: true },
  });
  const targets = apps.filter((a) => resolveGa4Target(a));

  const result: ReportResult = {
    refDate: isoDate(end),
    apps: 0,
    enqueued: 0,
    telegramSent: false,
    skipped: [],
  };
  const summary: string[] = [];

  for (const app of targets) {
    const rows = (await prisma.appMetricDaily.findMany({
      where: { appId: app.id },
      orderBy: { date: "desc" },
      take: RECENT_DAYS,
    })) as MetricRow[];
    if (rows.length === 0) {
      result.skipped.push(app.slug);
      continue;
    }
    const md = buildAppReportMd(app.displayName, rows, generatedOn);
    await enqueueVaultWrite({
      folder: REPORT_FOLDER,
      title: `${app.displayName} 지표`,
      content: md,
      source: "analytics",
    });
    result.enqueued++;
    result.apps++;
    summary.push(summaryLine(app.displayName, rows[0]));
  }

  if (summary.length > 0 && telegramConfigured()) {
    const link = env.optional("AUTH_URL").trim();
    const footer = link ? `\n\n🔗 ${esc(link)}/analytics` : "";
    await notify(
      [`📊 <b>앱 지표 리포트</b> (기준 ${esc(result.refDate)}, D-1)`, "", ...summary].join("\n") +
        footer,
    );
    result.telegramSent = true;
  }

  return result;
}
