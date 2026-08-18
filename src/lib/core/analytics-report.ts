import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { enqueueVaultWrite } from "@/lib/vault/write-core";
import { escapeHtml as esc } from "@/lib/format/html";
import { resolveGa4Target, latestClosedDay, isoDate } from "@/lib/ga4/datasets";
import { engagementRate, platformSegments } from "@/lib/ga4/metric-shapes";
import { listingsForSlug, resolveAitTarget } from "@/lib/analytics/ait-apps";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { configuredDestinations } from "@/lib/notifications/destinations";
import { htmlToDiscord } from "@/lib/notifications/format";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { reconcileMetricAnomalies } from "@/lib/analytics/anomalies";

// 일별 지표 보고서: 앱별 상세 노트를 Obsidian(프로젝트/지표)에 큐잉하고, 전체 요약을
// Discord로 발송. BigQuery/콘솔을 직접 치지 않고 저장된 스냅샷만 읽는다(AppMetricDaily=GA4,
// AppConsoleMetricDaily=AppsInToss 콘솔). 두 소스는 모수가 달라(GA4=전 표면, 콘솔=토스 표면)
// 한 줄로 합치지 않고 섹션을 나눠 함께 보고한다.
// vault-writer 가 파일명 앞에 처리일(KST)을 붙이므로 title 에는 날짜를 넣지 않는다.

const REPORT_FOLDER = "프로젝트/지표";
const RECENT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  adCtaUsers: number;
  adCtaImpressions: number;
  adCompletedUsers: number;
  adCompletions: number;
  networkAdUsers: number;
  networkAdImpressions: number;
  dauAndroid: number;
  dauIos: number;
  dauWeb: number;
}

/** 콘솔 리스팅 1건의 최신 스냅샷(리포트 표시에 쓰는 필드만). */
export interface ConsoleMetricRow {
  date: Date;
  dau: number | null;
  newUsers: number | null;
  avgSessionSec: number | null;
  iaaImpressions: number;
  iaaEarningKrw: number;
  iapTrxAmountKrw: number;
  payingUsers: number;
}

/** 콘솔 리스팅(App×miniApp) 한 건의 보고 항목. latest=null 이면 아직 push 수집이 없는 리스팅. */
export interface ConsoleReportItem {
  displayName: string;
  /** 한 앱이 콘솔에 여러 리스팅으로 등록된 경우에만 구분 라벨(단일 리스팅이면 null). */
  listingLabel: string | null;
  latest: ConsoleMetricRow | null;
}

export interface ConsoleReportSection {
  /** 운영 알림 메시지에 그대로 붙일 줄들(헤더 포함). 수집 데이터가 없으면 빈 배열. */
  lines: string[];
  /** 콘솔 최신 기준일 "YYYY-MM-DD"(수집 데이터가 없으면 null). */
  refDate: string | null;
  /** GA4 기준일 대비 지연 일수(수집 데이터가 없으면 null). */
  lagDays: number | null;
  /** 대상 리스팅 수. */
  listings: number;
  /** 그중 콘솔 기준일 스냅샷이 있어 합계에 포함된 리스팅 수. */
  onRefDate: number;
}

export interface ReportResult {
  refDate: string; // GA4 기준일(D-1)
  apps: number; // 보고서 생성된 앱 수
  enqueued: number; // Obsidian 쓰기 큐 건수
  notificationsQueued: number;
  skipped: string[]; // 스냅샷 없어 제외된 앱 slug
  consoleListings: number; // 콘솔 보고 대상 리스팅 수
  consoleRefDate: string | null; // 콘솔 기준일(온디맨드 수집이라 GA4 보다 늦을 수 있음)
  consoleLagDays: number | null; // GA4 기준일 대비 콘솔 지연 일수
}

const pct = (v: number | null): string => (v == null ? "—" : `${v}%`);
const numOrDash = (v: number | null): string => (v == null ? "—" : String(v));
const won = (v: number): string => `₩${Math.round(v).toLocaleString("ko-KR")}`;
// 콘솔 섹션은 금액과 함께 읽히므로 건수도 천 단위 구분자를 쓴다.
const count = (v: number): string => v.toLocaleString("ko-KR");
const countOrDash = (v: number | null): string => (v == null ? "—" : count(v));

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
    `- 활성사용자 ${latest.engagedUsers}명 · 참여율 ${pct(engagementRate(latest.engagedUsers, latest.dau))} · 평균 ${numOrDash(latest.avgEngageSec)}초`,
    `- 플랫폼 Android ${latest.dauAndroid} · iOS ${latest.dauIos} · Web ${latest.dauWeb}`,
    `- 광고 CTA 노출 ${latest.adCtaImpressions} · 고유 ${latest.adCtaUsers}명`,
    `- 광고 완료 ${latest.adCompletions} · 고유 ${latest.adCompletedUsers}명`,
    `- 실제 광고 노출 ${latest.networkAdImpressions} · 고유 ${latest.networkAdUsers}명`,
    "",
    `## 최근 ${rowsDesc.length}일 추이`,
    `| 날짜 | DAU | 신규 | D1 | D7 | CTA 노출 | 광고 완료 | 실제 노출 |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    ...rowsDesc.map(
      (r) =>
        `| ${day(r.date)} | ${r.dau} | ${r.newUsers} | ${pct(r.d1Pct)} | ${pct(r.d7Pct)} | ${r.adCtaImpressions} | ${r.adCompletions} | ${r.networkAdImpressions} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

/** Discord 변환 전 요약 한 줄(제한된 HTML). 활성사용자·참여율·플랫폼 반영. */
export function summaryLine(displayName: string, latest: MetricRow): string {
  const rate = engagementRate(latest.engagedUsers, latest.dau);
  const plat = platformSegments(latest.dauAndroid, latest.dauIos, latest.dauWeb)
    .segs.map((s) => `${s.label} ${s.value}`)
    .join("/");
  return (
    `<b>${esc(displayName)}</b> DAU ${latest.dau} · 활성 ${latest.engagedUsers}(${pct(rate)}) · D7 ${pct(latest.d7Pct)} · CTA ${latest.adCtaImpressions} · 완료 ${latest.adCompletions} · 실제노출 ${latest.networkAdImpressions}` +
    (plat ? ` · ${plat}` : "")
  );
}

/**
 * 콘솔 리스팅 한 줄(HTML). refDate 보다 오래된 스냅샷은 그 리스팅의 기준일을 함께 표기해
 * 다른 날짜의 값이 같은 날인 것처럼 읽히지 않게 한다.
 */
export function consoleSummaryLine(item: ConsoleReportItem, refDate: string): string {
  const name = item.listingLabel
    ? `${esc(item.displayName)}(${esc(item.listingLabel)})`
    : esc(item.displayName);
  if (!item.latest) return `<b>${name}</b> 수집 없음`;

  const r = item.latest;
  const parts = [
    `DAU ${countOrDash(r.dau)}`,
    `신규 ${countOrDash(r.newUsers)}`,
    `세션 ${r.avgSessionSec == null ? "—" : `${Math.round(r.avgSessionSec)}초`}`,
    `광고 ${count(r.iaaImpressions)}회 ${won(r.iaaEarningKrw)}`,
  ];
  // 결제는 대부분 0 이라 값이 있을 때만 붙인다.
  if (r.payingUsers > 0 || r.iapTrxAmountKrw > 0) {
    parts.push(`결제 ${count(r.payingUsers)}명 ${won(r.iapTrxAmountKrw)}`);
  }
  const day = isoDate(r.date);
  return `<b>${name}</b> ${parts.join(" · ")}${day === refDate ? "" : ` · ⏳${esc(day)}`}`;
}

/**
 * 콘솔 섹션(헤더 + 리스팅 줄 + 합계)을 만든다. 콘솔 수집은 cron 이 아닌 온디맨드 push 라
 * 리스팅마다 최신 기준일이 다를 수 있다. 그래서 (1) 섹션 기준일은 최신 스냅샷 날짜,
 * (2) 합계는 그 기준일 스냅샷이 있는 리스팅만 — 오래된 날짜를 섞어 총액을 부풀리지 않는다.
 * ga4RefDate 와의 차이는 지연 일수로 표기해 동기화가 밀렸음을 드러낸다.
 */
export function buildConsoleSection(
  items: ConsoleReportItem[],
  ga4RefDate: Date,
): ConsoleReportSection {
  const withData = items.filter((i) => i.latest != null);
  if (withData.length === 0) {
    return { lines: [], refDate: null, lagDays: null, listings: items.length, onRefDate: 0 };
  }

  const refMs = Math.max(...withData.map((i) => i.latest!.date.getTime()));
  const refDate = isoDate(new Date(refMs));
  const lagDays = Math.round((ga4RefDate.getTime() - refMs) / DAY_MS);

  // 매일 같은 규칙으로 정렬해 일자 간 비교가 쉽도록 한다(수익 → DAU → 이름).
  const ranked = [...withData].sort(
    (a, b) =>
      b.latest!.iaaEarningKrw - a.latest!.iaaEarningKrw ||
      (b.latest!.dau ?? 0) - (a.latest!.dau ?? 0) ||
      a.displayName.localeCompare(b.displayName),
  );
  const onRef = ranked.filter((i) => isoDate(i.latest!.date) === refDate);
  const sum = (f: (r: ConsoleMetricRow) => number): number =>
    onRef.reduce((s, i) => s + f(i.latest!), 0);
  // DAU 는 null(콘솔 미집계)과 0(방문 0명)을 구분한다 — 전부 null 이면 합계도 "—".
  const dauRows = onRef.filter((i) => i.latest!.dau != null);

  const totalParts = [
    `DAU ${dauRows.length ? count(dauRows.reduce((s, i) => s + (i.latest!.dau ?? 0), 0)) : "—"}`,
    `신규 ${count(sum((r) => r.newUsers ?? 0))}`,
    `광고 ${count(sum((r) => r.iaaImpressions))}회 ${won(sum((r) => r.iaaEarningKrw))}`,
  ];
  const iapTotal = sum((r) => r.iapTrxAmountKrw);
  if (iapTotal > 0) totalParts.push(`결제 ${won(iapTotal)}`);

  const lines = [
    `🧩 <b>AppsInToss 콘솔</b> (기준 ${esc(refDate)}` +
      (lagDays > 0 ? `, GA4 대비 ${lagDays}일 지연` : "") +
      ")",
    ...ranked.map((i) => consoleSummaryLine(i, refDate)),
    `<b>합계</b> ${totalParts.join(" · ")} (기준일 ${onRef.length}/${items.length} 리스팅)`,
  ];
  const noData = items.filter((i) => i.latest == null);
  if (noData.length > 0) {
    const names = noData.map((i) =>
      i.listingLabel ? `${esc(i.displayName)}(${esc(i.listingLabel)})` : esc(i.displayName),
    );
    lines.push(`⚠️ 수집 없음: ${names.join(", ")}`);
  }

  return { lines, refDate, lagDays, listings: items.length, onRefDate: onRef.length };
}

/**
 * Discord 변환 전 리포트 메시지 본문(제한된 HTML). GA4(전 표면)와 콘솔(토스 표면)은 모수가 달라 한 메시지 안에서
 * 섹션으로 나란히 싣는다. 각 섹션은 보고할 줄이 있을 때만 붙어, 한쪽 소스만 있어도 발송된다.
 */
export function buildReportMessage({
  refDate,
  ga4Lines,
  consoleLines,
  link,
}: {
  refDate: string;
  ga4Lines: string[];
  consoleLines: string[];
  /** 백오피스 링크(AUTH_URL). 비어 있으면 푸터를 생략한다. */
  link: string;
}): string {
  const lines = [`📊 <b>앱 지표 리포트</b> (기준 ${esc(refDate)}, D-1)`];
  if (ga4Lines.length > 0) lines.push("", "📈 <b>GA4</b>", ...ga4Lines);
  if (consoleLines.length > 0) lines.push("", ...consoleLines);
  return lines.join("\n") + (link ? `\n\n🔗 ${esc(link)}/analytics` : "");
}

type ConsoleAppRef = {
  id: string;
  slug: string;
  displayName: string;
  aitWorkspaceId: number | null;
  aitMiniAppId: number | null;
};

/** 콘솔 대상 앱들의 리스팅별 최신 스냅샷을 읽는다(App 당 리스팅 1:N). */
async function loadConsoleReportItems(apps: ConsoleAppRef[]): Promise<ConsoleReportItem[]> {
  const targets = apps.flatMap((app) => {
    const listings = listingsForSlug(app.slug);
    if (listings.length > 0) {
      return listings.map((l) => ({
        app,
        miniAppId: l.miniAppId,
        // 리스팅이 하나면 라벨이 앱명과 중복이라 생략한다.
        listingLabel: listings.length > 1 ? l.label : null,
      }));
    }
    const target = resolveAitTarget(app);
    return target ? [{ app, miniAppId: target.miniAppId, listingLabel: null }] : [];
  });

  return Promise.all(
    targets.map(async ({ app, miniAppId, listingLabel }) => ({
      displayName: app.displayName,
      listingLabel,
      latest: (await prisma.appConsoleMetricDaily.findFirst({
        where: { appId: app.id, miniAppId },
        orderBy: { date: "desc" },
        select: {
          date: true,
          dau: true,
          newUsers: true,
          avgSessionSec: true,
          iaaImpressions: true,
          iaaEarningKrw: true,
          iapTrxAmountKrw: true,
          payingUsers: true,
        },
      })) as ConsoleMetricRow | null,
    })),
  );
}

export async function sendMetricsReport(now: Date): Promise<ReportResult> {
  const end = latestClosedDay(now);
  const generatedOn = isoDate(now);

  const apps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      slug: true,
      displayName: true,
      firebaseProject: true,
      ga4Dataset: true,
      aitWorkspaceId: true,
      aitMiniAppId: true,
    },
  });
  const targets = apps.filter((a) => resolveGa4Target(a));
  const consoleApps = apps.filter((a) => resolveAitTarget(a));

  const result: ReportResult = {
    refDate: isoDate(end),
    apps: 0,
    enqueued: 0,
    notificationsQueued: 0,
    skipped: [],
    consoleListings: 0,
    consoleRefDate: null,
    consoleLagDays: null,
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
    await reconcileMetricAnomalies({
      appId: app.id,
      appSlug: app.slug,
      displayName: app.displayName,
      rowsDesc: rows,
    });
  }

  const consoleSection = buildConsoleSection(await loadConsoleReportItems(consoleApps), end);
  result.consoleListings = consoleSection.listings;
  result.consoleRefDate = consoleSection.refDate;
  result.consoleLagDays = consoleSection.lagDays;

  if (summary.length > 0 || consoleSection.lines.length > 0) {
    const reportHtml = buildReportMessage({
      refDate: result.refDate,
      ga4Lines: summary,
      consoleLines: consoleSection.lines,
      link: env.optional("AUTH_URL").trim(),
    });
    const destinations = configuredDestinations(["metrics-daily"]);
    await enqueueNotification({
      dedupeKey: `metrics:daily:${result.refDate}`,
      kind: "DAILY_METRICS",
      payload: { discordMarkdown: htmlToDiscord(reportHtml) },
      destinations,
    });
    result.notificationsQueued = destinations.length;
  }

  return result;
}
