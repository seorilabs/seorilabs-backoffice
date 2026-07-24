import type { ReleaseMarket, ReleaseStatus } from "@prisma/client";
import { esc } from "@/lib/telegram/client";

const MARKET_LABEL: Record<ReleaseMarket, string> = {
  AIT: "AppsInToss",
  PLAY: "Google Play",
  APPSTORE: "App Store",
  WEB: "Web",
};

export interface DeployCompletionPayload {
  releaseRecordId: string;
  status: Extract<ReleaseStatus, "SUCCEEDED" | "FAILED">;
  runUrl?: string;
}

export interface EnqueueDeployCompletionPayload extends DeployCompletionPayload {
  eventKey: string;
}

export function deployNotificationDedupeKey(
  releaseRecordId: string,
  eventKey: string,
): string {
  if (!/^[a-z0-9]{20,40}$/i.test(releaseRecordId)) {
    throw new Error("잘못된 releaseRecordId");
  }
  if (!/^[a-z0-9:_-]{1,120}$/i.test(eventKey)) {
    throw new Error("잘못된 배포 완료 eventKey");
  }
  return `deploy:${releaseRecordId}:${eventKey}`;
}

export function deployMarketLabel(market: ReleaseMarket): string {
  return MARKET_LABEL[market];
}

export function deployCompletionPayload(value: unknown): DeployCompletionPayload | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const releaseRecordId = String(
    (value as { releaseRecordId?: unknown }).releaseRecordId ?? "",
  );
  const runUrlRaw = (value as { runUrl?: unknown }).runUrl;
  const runUrl =
    typeof runUrlRaw === "string" && /^https:\/\//.test(runUrlRaw)
      ? runUrlRaw
      : undefined;
  const statusRaw = String((value as { status?: unknown }).status ?? "");
  if (!/^[a-z0-9]{20,40}$/i.test(releaseRecordId)) return null;
  if (statusRaw !== "SUCCEEDED" && statusRaw !== "FAILED") return null;
  return { releaseRecordId, status: statusRaw, runUrl };
}

export function buildDeployCompletionText(input: {
  displayName: string;
  version: string;
  market: ReleaseMarket;
  status: Extract<ReleaseStatus, "SUCCEEDED" | "FAILED">;
  workflowName?: string | null;
  externalBuildNumber?: number | null;
  runUrl?: string;
}): string {
  const succeeded = input.status === "SUCCEEDED";
  const lines = [
    `${succeeded ? "✅" : "❌"} <b>배포 ${succeeded ? "완료" : "실패"}</b>`,
    `앱: <b>${esc(input.displayName)}</b>`,
    `버전: <code>${esc(input.version)}</code>`,
    `마켓: ${esc(MARKET_LABEL[input.market])}`,
  ];
  if (input.workflowName) lines.push(`실행: ${esc(input.workflowName)}`);
  if (input.externalBuildNumber != null) {
    lines.push(`Xcode Cloud 빌드: #${input.externalBuildNumber}`);
  }
  if (input.runUrl) lines.push(`<a href="${esc(input.runUrl)}">실행 결과 보기</a>`);
  return lines.join("\n");
}

export function nextNotificationAttemptAt(attempts: number, now = new Date()): Date {
  const delayMs = Math.min(30_000 * 2 ** Math.max(0, attempts), 30 * 60_000);
  return new Date(now.getTime() + delayMs);
}
