import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { resolveGa4Target } from "@/lib/ga4/datasets";
import { resolveAitTarget } from "@/lib/analytics/ait-apps";
import { dbDay, toDbDay } from "@/lib/analytics/metric-day";
import type { SourceCoverage } from "@/lib/report/daily-contract";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { metricReportPartitions } from "./report-batches";
import { APPLE_REPORT_FIELDS } from "./report-files";

/** 보고서 종류를 합치지 않는다. SDK·게시 권한은 분석 보고 권한의 증거가 아니다. */
const reports = [
  ["ga4", "활성·신규·참여"], ["ga4-retention", "D1·D3·D7·D14·D30 잔존"],
  ["ga4-funnel", "첫 핵심 행동·이탈"],
  ["ait_console", "이용자·광고·결제"],
  ["play-acquisition", "방문·설치·삭제·유입"], ["play-sales", "판매·환불·구독"],
  ["play-finance", "정산"], ["reviews:GOOGLE_PLAY", "리뷰"], ["play-submissions", "출시 상태"],
  ...Object.keys(APPLE_REPORT_FIELDS).map((name) => ["apple-analytics", name] as const), ["apple-sales", "판매·추가 구독 보고"],
  ["apple-finance", "정산"], ["reviews:APP_STORE", "리뷰"], ["apple-submissions", "출시 상태"],
  ["android-vitals", "오류·영향 사용자"], ["crashlytics", "오류·영향 사용자"],
  ["firebase-performance", "시작·화면·네트워크 성능"], ["admob", "광고 요청·응답·노출·추정 수익"],
  ["backend-payments", "결제·지급 실패"], ["feedback", "고객 피드백"],
  ["apple-keyword", "검색 순위"], ["apple-public-lookup", "경쟁 앱 변화"],
  ["google-ads", "광고 비용·획득·전환"], ["apple-ads", "광고 비용·획득·전환"],
  ["firebase-experiments", "실험·Remote Config"], ["firebase-messaging", "메시지 결과"],
] as const;

export async function metricSourceInventory(day: string, db: Prisma.TransactionClient = prisma): Promise<SourceCoverage[]> {
  const apps = await db.app.findMany({
    where: visibleAppWhere, orderBy: { displayName: "asc" },
    select: { id: true, slug: true, displayName: true, firebaseProject: true, ga4Dataset: true,
      aitWorkspaceId: true, aitMiniAppId: true, playPackage: true, iosBundle: true,
      configRevisions: { where: { status: "ACTIVE" }, orderBy: { revision: "desc" }, take: 1, select: { revision: true, payload: true } } },
  });
  const ids = apps.map((app) => app.id);
  const [ledger, runs, partitions] = await Promise.all([
    db.metricCollectionLedger.findMany({ where: { appId: { in: ids }, day: toDbDay(day) } }),
    // GROUP BY 뒤 개별 최신 실행을 읽어 전역 take로 오래된 앱을 숨기지 않는다.
    db.sourceCollectionRun.groupBy({ by: ["appId", "source", "target"], where: { appId: { in: ids } }, _max: { startedAt: true } }),
    metricReportPartitions(day, db),
  ]);
  const latest = runs.length ? await db.sourceCollectionRun.findMany({
    where: { OR: runs.map((run) => ({ appId: run.appId, source: run.source, target: run.target, startedAt: run._max.startedAt! })) },
    orderBy: { startedAt: "desc" },
  }) : [];
  return apps.flatMap((app) => reports.flatMap(([source, reportType]) => {
    const payload = configRevisionPayloadSchema.safeParse(app.configRevisions[0]?.payload);
    const sourceKey = source === "play-acquisition" ? "play-reports" : source;
    const connections = payload.success ? payload.data.analyticsSources?.filter((one) => one.source === sourceKey) ?? [] : [];
    return (connections.length ? connections : [null]).map((connection): SourceCoverage => {
    const batches = partitions.filter((one) => one.appId === app.id && one.source === sourceKey && (!connection || one.accountId === connection.accountId && one.resourceId === connection.resourceId) && (source !== "apple-analytics" || one.reportType === reportType));
    const ga4 = source.startsWith("ga4") ? resolveGa4Target(app) : null;
    const ait = source === "ait_console" ? resolveAitTarget(app) : null;
    const cells = ledger.filter((cell) => cell.appId === app.id && cell.source === source);
    const run = latest.find((one) => one.appId === app.id && one.source === sourceKey && (!connection || one.target === connection.id));
    let state: SourceCoverage["state"] = "needs_input";
    let reason = "이 보고서의 계정·권한·내보내기 연결을 아직 확인하지 못했습니다.";
    let remedy = "중앙 설정에 공급자 계정·보고서 종류·기존 credential logical ID를 연결하고 읽기 검증을 실행하세요.";
    if (batches.length) {
      const latestDay = batches.reduce((a, b) => a > b.periodEnd ? a : b.periodEnd, "");
      const rows = batches.filter((batch) => batch.periodEnd === latestDay).flatMap((batch) => batch.rows);
      state = rows.every((row) => row.state === "empty") ? "empty" : rows.every((row) => ["empty", "observed"].includes(row.state)) ? "observed" : "partial";
      reason = `${latestDay} · ${batches.length}개 날짜·출처 partition · ${connection?.timeZone ?? "원천 시간대"}. 비공개 셀은 0으로 계산하지 않습니다.`;
      remedy = state === "partial" ? "원천의 비공개·누락 셀과 분모를 확인하세요." : "";
    } else if (connection && !connection.enabled) {
      state = "needs_input"; reason = "운영자가 이 소스의 수집을 중지했습니다."; remedy = "기존 설정 서비스를 통해 연결을 활성화하세요.";
    } else if (cells.length) {
      state = cells.every((cell) => cell.state === "empty") ? "empty"
        : cells.every((cell) => ["observed", "empty"].includes(cell.state)) ? "observed"
        : cells.some((cell) => ["observed", "empty"].includes(cell.state)) ? "partial"
        : cells.some((cell) => cell.state === "failed") ? "failed" : "not_landed";
      reason = `${day} 원장 ${cells.filter((cell) => ["observed", "empty"].includes(cell.state)).length}/${cells.length}개 대상 관측`;
      remedy = ["observed", "empty"].includes(state) ? "" : "누락 원천의 내보내기와 수집 실행을 확인하세요.";
    } else if (run) {
      state = ["observed", "empty", "not_landed", "partial", "needs_input", "failed", "not_applicable"].includes(run.status)
        ? run.status as SourceCoverage["state"] : "partial";
      // 파일·응답이 비었다는 기록을 실적 0으로 바꾸지 않는다.
      if (state === "empty") state = "not_landed";
      reason = run.errorCode ?? `${run.completedAt ? "완료" : "진행 중"} 실행 ${run.id}`;
      if (state === "observed") remedy = "";
    } else if (ga4 || ait) {
      state = "not_landed";
      reason = "수집 대상은 연결되어 있으나 이 보고서 종류의 관측 근거가 없습니다.";
      remedy = source === "ga4" || source === "ait_console" ? "원천 도착·수집 실행을 확인하세요." : "이벤트·코호트 지원 범위와 내보내기를 확인하세요.";
    } else if (connection?.enabled) {
      state = "not_landed"; reason = "연결은 활성화되어 있으나 이 종류의 공식 보고서 자료가 아직 없습니다."; remedy = source === "apple-analytics" ? "최초 요청은 생성 뒤 자료 도착을 기다려야 합니다. 수집 실행과 보고서 권한을 확인하세요." : "원천 도착·보고 권한을 확인하세요.";
    }
    if (connection?.enabled && source === "apple-analytics" && !batches.length && state === "observed") { state = "not_landed"; reason = "수집 실행은 완료됐지만 이 보고서 종류의 자료는 아직 도착하지 않았습니다."; remedy = "원천 보고서 생성·동의·비공개 범위를 확인하세요."; }
    if ((source.startsWith("apple") || source === "reviews:APP_STORE") && !app.iosBundle || (source.startsWith("play") || source === "reviews:GOOGLE_PLAY" || source === "android-vitals") && !app.playPackage) { state = "not_applicable"; reason = "운영 대상에 이 마켓의 앱 식별자가 없습니다."; remedy = ""; }
    return { appId: app.id, slug: app.slug, appName: app.displayName, source, reportType,
      account: connection?.accountId ?? (ga4 ? `${ga4.firebaseProject}.${ga4.dataset}` : ait ? `workspace:${ait.workspaceId}` : null),
      credentialId: connection?.credentialId ?? (ga4 ? "shared/gcp/ga4-fleet-reader" : null), state, reason, remedy,
      dataThrough: batches.length ? batches.reduce((a, b) => a > b.periodEnd ? a : b.periodEnd, "") : cells.some((cell) => ["observed", "empty"].includes(cell.state)) ? day
        : run?.dataThrough ? dbDay(run.dataThrough) : null,
      runId: run?.id ?? null, configRevision: app.configRevisions[0]?.revision ?? null };
    });
  }));
}
