import { DISCORD_COMMANDS, registerDiscordGuildCommands } from "@/lib/discord/commands";
async function main() {
  const apply = process.argv.includes("--apply");
  if (process.argv.slice(2).some((arg) => !["--apply", "--dry-run"].includes(arg)))
    throw new Error("지원하지 않는 옵션입니다.");
  if (apply && process.argv.includes("--dry-run"))
    throw new Error("--apply와 --dry-run은 함께 사용할 수 없습니다.");
  if (!apply) {
    console.log(
      JSON.stringify({
        mode: "dry-run",
        commands: DISCORD_COMMANDS.map((command) => command.name),
      }),
    );
    return;
  }
  console.log(JSON.stringify({ mode: "registered", ...(await registerDiscordGuildCommands()) }));
}
main().catch(() => {
  console.error("Discord 명령 등록 실패: 대상 설정·권한을 확인하세요.");
  process.exitCode = 1;
});
