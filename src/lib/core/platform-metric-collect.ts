import { createPlatformReadClient } from "@/lib/platform/read-client";
import { platformReadConfiguration } from "@/lib/platform/read-client";
import { metricSampleFrom } from "@/lib/platform/metric-samples";
import { prisma } from "@/lib/prisma";

/**
 * 플랫폼 사용자 규모를 한 시점 스냅샷으로 저장한다.
 *
 * 매시 정각 CronJob이 부른다. 백필이 불가능하므로(platform의 lastSeenAt은
 * 덮어쓰기) 놓친 시각은 영구히 빈다. 그래서 실패를 조용히 삼키지 않고
 * 호출자에게 올린다 — CronJob이 실패로 끝나야 재시도가 걸린다.
 */
export async function collectPlatformUserMetrics(now: Date): Promise<{
  captured: boolean;
  capturedAt: string | null;
  reason?: string;
}> {
  const configuration = platformReadConfiguration();
  if (!configuration.configured) {
    // 설정이 없는 환경에서 CronJob이 계속 실패하면 알림이 무뎌진다.
    // 수집하지 않았다는 사실만 남기고 성공으로 끝낸다.
    return { captured: false, capturedAt: null, reason: configuration.message };
  }

  const client = createPlatformReadClient();
  const metrics = await client.metrics();
  if (metrics === null) {
    // 구버전 Admin API. 배포가 끝나면 저절로 낫는다.
    return {
      captured: false,
      capturedAt: null,
      reason: "Admin API가 지표 조회를 제공하지 않습니다.",
    };
  }

  const sample = metricSampleFrom(metrics, now);
  // 같은 정시에 두 번 돌아도 행이 늘지 않는다. 재시도가 그래프에
  // 중복 점을 만들면 안 된다.
  await prisma.platformUserMetricSample.upsert({
    where: { capturedAt: sample.capturedAt },
    create: sample,
    update: sample,
  });

  return { captured: true, capturedAt: sample.capturedAt.toISOString() };
}
