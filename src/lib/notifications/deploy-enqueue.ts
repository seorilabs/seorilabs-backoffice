import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import {
  deployNotificationDedupeKey,
  type EnqueueDeployCompletionPayload,
} from "@/lib/notifications/deploy-format";

// 배포 알림 enqueue 전용. 전달(deploy.ts)은 App Store Connect 를 호출하는데, 이 경로는
// workflow_run 미러 → 부팅 스케줄러까지 이어져 edge instrumentation 번들에 들어간다.
// enqueue 를 분리해 미러가 node:crypto 의존을 끌고 들어가지 않게 한다.

export async function enqueueDeployCompletionNotification(
  payload: EnqueueDeployCompletionPayload,
): Promise<void> {
  await enqueueNotification({
    dedupeKey: deployNotificationDedupeKey(payload.releaseRecordId, payload.eventKey),
    kind: "DEPLOY_COMPLETION",
    payload: {
      releaseRecordId: payload.releaseRecordId,
      status: payload.status,
      ...(payload.runUrl ? { runUrl: payload.runUrl } : {}),
    },
    destinations: discordDestinations(["release-ops"]),
  });
}

/**
 * deploy-all 은 ReleaseRecord 가 없어 배포 상태 카드 경로를 타지 못한다. 실행 단위 결과를
 * 같은 릴리즈 채널에 단발 알림으로 남겨 ALL 배포가 무음으로 끝나지 않게 한다.
 */
export async function enqueueDeployAllResultNotification(input: {
  text: string;
  eventKey: string;
  occurredAt: Date;
}): Promise<void> {
  await enqueueNotification({
    dedupeKey: `deploy-all:${input.eventKey}`,
    kind: "OPS_ALERT",
    payload: { text: input.text },
    occurredAt: input.occurredAt,
    destinations: discordDestinations(["release-ops"]),
  });
}
