import type { ReleaseMarket, ReleaseStatus } from "@prisma/client";

const MARKET_LABEL: Record<ReleaseMarket, string> = {
  AIT: "AppsInToss",
  PLAY: "Google Play",
  APPSTORE: "App Store",
  WEB: "Web",
};

export interface DeployCompletionPayload {
  releaseRecordId: string;
  status: ReleaseStatus;
  runUrl?: string;
}

export interface EnqueueDeployCompletionPayload extends DeployCompletionPayload {
  eventKey: string;
}

export function deployNotificationDedupeKey(releaseRecordId: string, eventKey: string): string {
  if (!/^[a-z0-9]{20,40}$/i.test(releaseRecordId)) throw new Error("잘못된 releaseRecordId");
  if (!/^[a-z0-9:_-]{1,120}$/i.test(eventKey)) throw new Error("잘못된 배포 eventKey");
  return `deploy:${releaseRecordId}:${eventKey}`;
}

export function deployCompletionPayload(value: unknown): DeployCompletionPayload | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const releaseRecordId = String((value as { releaseRecordId?: unknown }).releaseRecordId ?? "");
  const runUrlRaw = (value as { runUrl?: unknown }).runUrl;
  const runUrl = typeof runUrlRaw === "string" && /^https:\/\//.test(runUrlRaw)
    ? runUrlRaw
    : undefined;
  const status = String((value as { status?: unknown }).status ?? "") as ReleaseStatus;
  if (!/^[a-z0-9]{20,40}$/i.test(releaseRecordId)) return null;
  if (!["PENDING", "IN_PROGRESS", "SUCCEEDED", "FAILED", "ROLLED_BACK"].includes(status)) {
    return null;
  }
  return { releaseRecordId, status, runUrl };
}

const WORKFLOW_STATUS_LABEL: Record<ReleaseStatus, string> = {
  PENDING: "☑️ 요청됨",
  IN_PROGRESS: "⏳ 진행 중",
  SUCCEEDED: "✅ 업로드 경로 성공",
  FAILED: "❌ 실패",
  ROLLED_BACK: "↩️ 롤백됨",
};

const REMAINING_GATES: Record<ReleaseMarket, string[]> = {
  PLAY: ["Play 처리: ⚪ 미확인", "내부 테스터 설치 QA: ⚪ 미확인", "프로덕션 승격·심사: ⚪ 미실행", "승인: ⚪ 미확인", "공개 배포: ⚪ 미실행"],
  APPSTORE: ["App Store 처리: ⚪ 미확인", "TestFlight 설치 QA: ⚪ 미확인", "심사 제출: ⚪ 미실행", "승인: ⚪ 미확인", "공개 배포: ⚪ 미실행"],
  AIT: ["AppsInToss 처리: ⚪ 미확인", "샌드박스 설치 QA: ⚪ 미확인", "검수 제출: ⚪ 미실행", "승인: ⚪ 미확인", "공개 배포: ⚪ 미실행"],
  WEB: ["배포 반영: ⚪ 미확인", "live smoke: ⚪ 미실행"],
};

export function buildDeployStatusCardText(input: {
  displayName: string;
  version: string;
  market: ReleaseMarket;
  status: ReleaseStatus;
  workflowName?: string | null;
  externalBuildNumber?: number | null;
  runUrl?: string;
  updatedAt: Date;
}): string {
  const lines = [
    `🚀 **${input.displayName} ${input.version} · ${MARKET_LABEL[input.market]}**`,
    "",
    `빌드·업로드 워크플로: ${WORKFLOW_STATUS_LABEL[input.status]}`,
    ...REMAINING_GATES[input.market],
  ];
  if (input.workflowName) lines.push(`실행: ${input.workflowName}`);
  if (input.externalBuildNumber != null) lines.push(`Xcode Cloud 빌드: #${input.externalBuildNumber}`);
  if (input.runUrl) lines.push(`[실행 결과 보기](${input.runUrl})`);
  lines.push(`마지막 갱신: ${new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(input.updatedAt)}`);
  return lines.join("\n");
}
