// Next.js 서버 부팅 훅. node 런타임에서만 reconcile 스케줄러 기동.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_SCHEDULER === "true") return;
  const { startScheduler } = await import("@/lib/sync/scheduler");
  startScheduler();
}
