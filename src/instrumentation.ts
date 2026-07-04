// Next.js 서버 부팅 훅. node 런타임에서만 reconcile 스케줄러 기동.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_SCHEDULER === "true") return;
  const { startScheduler } = await import("@/lib/sync/scheduler");
  startScheduler();

  // 텔레그램 봇 명령어 메뉴 자동 등록. import 를 이 가드(nodejs) 안에서 수행해야
  // Edge instrumentation 번들에서 dead-code 로 제거된다(handlers→write-core→node:path).
  // 네트워크 호출은 부팅을 막지 않도록 fire-and-forget.
  try {
    const { telegramConfigured, setMyCommands, setChatMenuButton } = await import(
      "@/lib/telegram/client"
    );
    if (telegramConfigured()) {
      const { BOT_COMMANDS } = await import("@/lib/telegram/commands");
      void Promise.all([setMyCommands(BOT_COMMANDS), setChatMenuButton()])
        .then(() => console.log("[telegram] 명령어 메뉴 등록 완료"))
        .catch((e) =>
          console.error("[telegram] 명령어 등록 실패:", e instanceof Error ? e.message : e),
        );
    }
  } catch (e) {
    console.error("[telegram] 명령어 등록 실패:", e instanceof Error ? e.message : e);
  }
}
