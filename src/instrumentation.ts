// Next.js 서버 부팅 훅. node 런타임에서만 reconcile 스케줄러 기동.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_SCHEDULER === "true") return;
  const { startScheduler } = await import("@/lib/sync/scheduler");
  startScheduler();
  void registerTelegramCommands();
}

async function registerTelegramCommands(): Promise<void> {
  try {
    const { telegramConfigured, setMyCommands, setChatMenuButton } = await import(
      "@/lib/telegram/client"
    );
    if (!telegramConfigured()) return;
    const { BOT_COMMANDS } = await import("@/lib/telegram/handlers");
    await setMyCommands(BOT_COMMANDS);
    await setChatMenuButton();
    console.log("[telegram] 명령어 메뉴 등록 완료");
  } catch (e) {
    console.error("[telegram] 명령어 등록 실패:", e instanceof Error ? e.message : e);
  }
}
