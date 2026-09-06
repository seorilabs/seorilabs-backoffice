import {
  loadPlatformPresenceSnapshot,
  type PlatformPresenceSnapshot,
} from "./presence";

export const PRESENCE_EDGE_READY_URL = "https://edge.vzyx.xyz/health/ready";
export const PRESENCE_INGEST_READY_URL =
  "https://platform-ingest-306278488979.asia-northeast3.run.app/health/ready";
const PRESENCE_HEALTH_TIMEOUT_MS = 2_000;

export interface PresencePipelineDependencies {
  checkEdge: () => Promise<void>;
  checkIngest: () => Promise<void>;
  loadSnapshot: () => Promise<PlatformPresenceSnapshot>;
}

async function assertReady(url: string, label: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(PRESENCE_HEALTH_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`${label}가 응답하지 않습니다.`);
  }
  if (!response.ok) throw new Error(`${label}가 준비되지 않았습니다.`);
}

/**
 * presence 집계를 신뢰할 수 있는 상태인지 확인한다.
 *
 * Edge가 죽으면 heartbeat가 끊겨 활성 행이 만료되므로, 확인 없이 읽으면
 * 장애를 "사용자가 줄었다"로 읽게 된다. 동접 수와 버전 분포가 같은 테이블을
 * 보므로 같은 확인을 공유한다.
 */
export async function assertPresencePipelineReady(): Promise<void> {
  await Promise.all([
    assertReady(PRESENCE_EDGE_READY_URL, "RPI Edge"),
    assertReady(PRESENCE_INGEST_READY_URL, "Platform ingest"),
  ]);
}

/** Edge·token issuer·DB가 모두 정상일 때만 현재 동접 snapshot을 반환한다. */
export async function loadPlatformPresencePipelineSnapshot(
  dependencies: PresencePipelineDependencies = {
    checkEdge: () => assertReady(PRESENCE_EDGE_READY_URL, "RPI Edge"),
    checkIngest: () => assertReady(PRESENCE_INGEST_READY_URL, "Platform ingest"),
    loadSnapshot: () => loadPlatformPresenceSnapshot(),
  },
): Promise<PlatformPresenceSnapshot> {
  await Promise.all([dependencies.checkEdge(), dependencies.checkIngest()]);
  return dependencies.loadSnapshot();
}
