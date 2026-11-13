
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
