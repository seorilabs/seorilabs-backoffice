import type { CronObservation } from "./contract";
import { expectedSchedules } from "./contract";
import { notificationDestinations } from "@/lib/notifications/destinations";
import { EMBED_COLOR } from "@/lib/notifications/style";
import { kstTime } from "@/lib/analytics/console-sync/report";

const labels: Record<string, string> = {
  "book-sales-kdp": "KDP 판매 보고서 수집", "backoffice-ait-console-metrics": "앱인토스 지표 수집",
  "backoffice-analytics-collect": "앱 사용 지표 수집", "backoffice-analytics-recollect": "앱 사용 지표 재집계",
  "backoffice-analytics-report": "앱 사용 지표 보고", "backoffice-app-content-analytics-collect": "앱 콘텐츠 지표 수집",
  "backoffice-automation-scheduler": "자동 작업 대기열 점검", "backoffice-batch-observer": "예약 작업 감시",
  "backoffice-daily-digest": "개발 일일 요약", "backoffice-db-backup": "운영 DB 백업",
  "backoffice-desired-state-backfill": "운영 설정 보완", "backoffice-extended-metrics": "스토어 지표 수집",
  "backoffice-finance-report": "일일 수익 보고", "backoffice-fleet-project-projection": "앱 통합 관리 갱신",
  "backoffice-godot-version-check": "Godot 버전 확인", "backoffice-keyword-daily": "검색 순위 보고",
  "backoffice-market-feedback": "스토어 의견 수집", "backoffice-metric-daily-reconcile": "일일 지표 대조",
  "backoffice-metric-highlights": "지표 주요 변화 보고", "backoffice-metric-landing-probe": "지표 도착 확인",
  "backoffice-metric-report-prepare": "지표 보고서 준비", "backoffice-operations-report": "운영 일일 보고",
  "backoffice-platform-metric-collect": "공통 서비스 지표 수집", "backoffice-realtime-spike": "실시간 활동 변화 확인",
  "backoffice-reconcile": "GitHub 이력 대조", "backoffice-registry-seed": "앱 목록 갱신",
  "backoffice-repository-discovery-backfill": "저장소 구성 확인", "backoffice-store-reviews": "스토어 리뷰 수집",
  "backoffice-store-submissions": "스토어 심사 상태 확인", "backoffice-weekly-insights": "주간 운영 분석",
  "backoffice-weekly-liveops": "주간 게임 운영 보고", "backoffice-xcode-cloud-sync": "iOS 빌드 상태 확인",
  "backoffice-provider-audit-trigger-verify": "외부 실행 감사 기록 확인", "vault-writer": "문서 보관 작업",
  "registry-safe-gc": "컨테이너 저장소 정리",
};
export const batchName = (name: string) => labels[name] ?? name.replace(/^backoffice-/, "");
const frequencyCache = new Map<string, boolean>();
export function frequentBatch(cron: CronObservation, now: Date): boolean {
  const day = now.toISOString().slice(0, 10);
  const key = `${day}:${cron.schedule}:${cron.timeZone}`;
  if (!frequencyCache.has(key)) {
    if (frequencyCache.size > 200) frequencyCache.clear();
    const start = new Date(`${day}T00:00:00Z`);
    frequencyCache.set(key, (expectedSchedules({ ...cron, suspended: false }, start, new Date(start.getTime() + 86400000)) ?? 0) > 48);
  }
  return frequencyCache.get(key)!;
}
export const hourStart = (date: Date) => new Date(Math.floor(date.getTime() / 3600000) * 3600000);
export interface ReportableRun {
  id: string; name: string; status: string; startedAt: string; completedAt: string | null;
  expected?: number | null; verified?: number | null; errorCode?: string;
}
export function batchResultNotification(run: ReportableRun) {
  const failed = run.status === "failed";
  const kdp = run.name === "book-sales-kdp";
  const uid = run.id.replace(/^batch:k8s:/, "");
  const lines = [`시작 ${kstTime(new Date(run.startedAt))}`, `종료 ${run.completedAt ? kstTime(new Date(run.completedAt)) : "미확인"} (한국 시간)`];
  if (kdp) lines.push(`대상 ${run.expected ?? "미확인"}개월, 저장 대조 ${run.verified ?? "미확인"}개월`);
  else lines.push("실행 종료 상태를 확인했습니다. 자료 완성도는 해당 수집 보고서에서 확인합니다.");
  if (run.errorCode) lines.push(`오류 코드: ${run.errorCode}`);
  if (failed) lines.push("조치: 장애알림의 실패 원인과 실행 기록을 확인하세요.");
  return { dedupeKey: run.name === "backoffice-ait-console-metrics" ? `ait-console-collection:${uid}` : `batch-result:${run.id}`,
    kind: "OPERATIONAL_EVENT" as const, occurredAt: new Date(run.completedAt ?? run.startedAt),
    destinations: notificationDestinations(["batch-monitoring"]), payload: {
      report: { category: "response", reason: "USER_REQUESTED_BATCH_RESULT" }, source: "scheduled-batch", runId: run.id,
      executionStatus: run.status, text: lines.join("\n"),
      embed: { title: `${failed ? "❌" : "✅"} ${batchName(run.name)} ${failed ? "실패" : "성공"}`,
        color: failed ? EMBED_COLOR.FAILURE : EMBED_COLOR.SUCCESS },
    } };
}
