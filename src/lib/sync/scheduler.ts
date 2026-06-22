import { reconcileAll } from "@/lib/sync/backfill";
import { env } from "@/lib/env";

let started = false;

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
}
