import type { LegacyConfigResolutionRequest, ReleaseGateName } from "@/lib/control-plane/contracts";
import type { FleetLifecycleStageName } from "@/lib/control-plane/lifecycle-policy";

// 화면 표시만 바꾼다. 저장값, API 값, 권한 판정에는 사용하지 않는다.
const lifecycleLabels = {
  IDEA: "아이디어",
  PLANNING: "기획",
  SPEC_REVIEW: "기획 검토",
  APPROVED: "개발 승인",
  BUILD: "개발",
  QA: "품질 확인",
  RELEASE_ASSETS: "출시 자료 준비",
  RELEASE_CANDIDATE: "출시 후보",
  SUBMITTED: "업로드 완료",
  REVIEW: "심사 중",
  APPROVED_FOR_RELEASE: "출시 승인",
  DEPLOYED: "배포 완료",
  PUBLIC_VERIFIED: "공개 상태 확인",
  MONITORED: "운영 모니터링",
} satisfies Record<FleetLifecycleStageName, string>;

const gateLabels = {
  IMPLEMENTATION: "기능 구현",
  CI: "자동 검사",
  ARTIFACT: "빌드 결과물",
  RELEASE_ASSETS: "출시 자료",
  COMPLIANCE_DRAFT: "정책·신고 정보 초안",
  PROVIDER_SHELL: "마켓 앱 등록",
  UPLOAD: "업로드",
  PROCESSING: "마켓 처리",
  DEVICE_QA: "실기기 확인",
  REVIEW: "심사",
  APPROVAL: "출시 승인",
  DEPLOYMENT: "배포",
  PUBLIC: "공개 상태 확인",
} satisfies Record<ReleaseGateName, string>;

const statusLabels = {
  ACTIVE: "적용 중",
  DRAFT: "초안",
  SUPERSEDED: "이전 버전",
  DISABLED: "사용 안 함",
  PAUSED: "일시중지",
  PENDING: "대기 중",
  RUNNING: "진행 중",
  SUCCEEDED: "성공",
  COMPLETED: "완료",
  FAILED: "실패",
  CANCELLED: "취소됨",
  DEAD_LETTER: "재시도 한도 초과",
  REVOKED: "사용 철회됨",
  EXPIRED: "만료됨",
  MATCH: "일치",
  MISMATCH: "불일치",
  FULL_MATCH: "전체 일치",
  BLOCKED: "진행 불가",
  READY: "준비됨",
  PASSED: "통과",
  SKIPPED: "검사 제외",
  COMPLIANT: "기준 충족",
  MANAGED: "중앙 관리 중",
  UNMANAGED: "중앙 관리 미적용",
  PRODUCT_APP: "제품 앱",
  INFRA_REPO: "운영 도구 저장소",
  PLATFORM_PRODUCER: "공통 기능 저장소",
  EXCLUDED: "관리 제외",
  ARCHIVED: "보관됨",
  UNCLASSIFIED: "미분류",
  PR_MERGED: "변경 병합됨",
  ISSUE_OPEN: "작업 등록됨",
  GRANTED: "권한 있음",
  MISSING_REQUIREMENT: "필수 권한 부족",
  HUMAN_REAUTH_REQUIRED: "직접 로그인 필요",
  TRUSTED_LOCAL_PENDING: "내 기기에서 로그인 대기",
  NEEDS_REAUTH: "재로그인 필요",
  NEEDS_INPUT: "입력 필요",
  DRAFT_CREATED: "초안 생성됨",
  DRAFT_CREATED_WITH_INPUT: "초안 생성됨 · 추가 입력 필요",
  WAITING_HUMAN_APPROVAL: "승인 대기",
  HUMAN_REQUIRED: "사용자 확인 필요",
  QUEUED: "실행 대기",
  STALE: "최신 상태 확인 필요",
  PLATFORM_SOURCE_STALE: "공통 기능 소스 갱신 필요",
  READBACK_REQUIRED: "외부 결과 확인 필요",
  READBACK_FIRST: "외부 결과 먼저 확인",
  READ_ONLY: "조회만",
  READY_PR: "변경 검토 요청까지",
  APPROVED: "승인됨",
} as const;

const optionLabels = {
  "google-play": "Google Play",
  "app-store": "App Store",
  "apps-in-toss": "앱인토스",
  icon: "앱 아이콘",
  "feature-graphic": "스토어 홍보 이미지",
  thumbnail: "썸네일",
  screenshot: "스크린샷",
  "data-safety": "데이터 보안",
  privacy: "개인정보 처리",
  "content-rating": "콘텐츠 등급",
  "export-compliance": "수출 규정 준수",
  "review-notes": "심사 참고 사항",
  internal: "내부 테스트",
  closed: "비공개 테스트",
  open: "공개 테스트",
  production: "정식 배포",
  testflight: "TestFlight 테스트",
  private: "비공개 테스트",
  public: "공개 배포",
  OFF: "사용 안 함",
  MONITOR: "모니터링만",
  ENFORCED: "검증 필수",
  ANDROID: "Android",
  IOS: "iOS",
  WEB: "웹",
  AIT: "앱인토스",
  VIEWER: "조회 담당자",
  OPERATOR: "운영 담당자",
  ADMIN: "관리자",
  KRW: "원화",
  USD: "미국 달러",
  text: "텍스트",
  boolean: "예 / 아니오",
  record: "항목별 입력",
} as const;

const evidenceLabels = {
  CONFIG_REVISION: "설정 버전",
  BUILD_TARGET: "빌드 대상",
  MARKET_LOCALIZATION: "스토어 소개",
  COMPLIANCE_PROFILE: "정책·신고 정보",
  PROVIDER_OBSERVATION: "마켓·서비스 확인 기록",
  STORE_ASSET: "스토어 이미지·파일",
  EXTERNAL_BINDING: "외부 서비스 연결",
  PLATFORM_FLEET_BINDING: "공통 기능 적용 현황",
  CREDENTIAL_BINDING: "계정·키 연결",
  AUTOMATION_DEFINITION: "자동 작업",
  IGNORED_NON_OPERATIONAL: "운영에 쓰지 않는 값 — 이관 제외",
} satisfies Record<LegacyConfigResolutionRequest["dispositions"][number]["targets"][number], string>;

function label(labels: Readonly<Record<string, string>>, value: string): string {
  // 새 상태나 알 수 없는 값은 숨기거나 정상 상태로 오인시키지 않는다.
  return Object.hasOwn(labels, value) ? labels[value] : value;
}

export function lifecycleStageLabel(value: string): string {
  return label(lifecycleLabels, value);
}

export function releaseGateLabel(value: string): string {
  return label(gateLabels, value);
}

export function managementStatusLabel(value: string): string {
  return label(statusLabels, value);
}

export function configOptionLabel(value: string): string {
  return label(optionLabels, value);
}

export function legacyEvidenceLabel(value: string): string {
  return label(evidenceLabels, value);
}
