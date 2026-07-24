import { reconcileAll } from "@/lib/sync/backfill";
import { env } from "@/lib/env";
import { drainTelegramNotifications } from "@/lib/telegram/deploy-notifications";

let started = false;

async function triggerInternalPost(
  path: string,
  body?: object,
  timeoutMs = 20_000,
): Promise<void> {
  const token = process.env.INTERNAL_ADMIN_TOKEN?.trim();
  if (!token) return;
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: {
      "x-admin-token": token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}`);
  }
}

// 서버 부팅 시 1회 시작. webhook 유실분 복구용 주기 reconcile.
export function startScheduler(): void {
  if (started) return;
  started = true;
  const interval = env.reconcileIntervalMs();

  setTimeout(() => {
    reconcileAll().catch((e) => console.error("[scheduler] initial reconcile", e));
  }, 15_000);

  setInterval(() => {
    reconcileAll().catch((e) => console.error("[scheduler] reconcile", e));
  }, interval);

  setTimeout(() => {
    drainTelegramNotifications().catch((e) =>
      console.error("[scheduler] telegram notifications", e),
    );
    triggerInternalPost("/api/admin/xcode-cloud/sync", undefined, 5 * 60_000).catch((e) =>
      console.error("[scheduler] xcode cloud", e),
    );
  }, 15_000);
  setTimeout(() => {
    triggerInternalPost("/api/admin/seed", { backfill: false }, 5 * 60_000).catch((e) =>
      console.error("[scheduler] registry seed", e),
    );
  }, 30_000);

  // webhook 은 outbox 까지만 기록하고 Telegram 네트워크/Apple 상태 조회는 서버 루프가 맡는다.
  setInterval(() => {
    drainTelegramNotifications().catch((e) =>
      console.error("[scheduler] telegram notifications", e),
    );
  }, 30_000);
  setInterval(() => {
    triggerInternalPost("/api/admin/xcode-cloud/sync", undefined, 5 * 60_000).catch((e) =>
      console.error("[scheduler] xcode cloud", e),
    );
  }, 60_000);
  // 신규 저장소와 한글 표시명을 자동 반영한다. 이슈/PR backfill은 기존 reconcile이 담당한다.
  setInterval(() => {
    triggerInternalPost("/api/admin/seed", { backfill: false }, 5 * 60_000).catch((e) =>
      console.error("[scheduler] registry seed", e),
    );
  }, 6 * 60 * 60_000);
}
