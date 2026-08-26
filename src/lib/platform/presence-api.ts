import type { PlatformPresenceSnapshot } from "./presence";

export type PlatformPresenceApiResult =
  | { status: 200; body: { ok: true; snapshot: PlatformPresenceSnapshot } }
  | { status: 503; body: { ok: false; error: string } };

/** API의 정상 0과 집계 실패를 HTTP 상태부터 분리한다. */
export async function loadPresenceApiResult(
  loader: () => Promise<PlatformPresenceSnapshot>,
): Promise<PlatformPresenceApiResult> {
  try {
    return { status: 200, body: { ok: true, snapshot: await loader() } };
  } catch {
    return {
      status: 503,
      body: { ok: false, error: "presence 집계를 읽지 못했습니다." },
    };
  }
}
