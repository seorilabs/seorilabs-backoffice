import { env } from "@/lib/env";
import { putDiscordApi } from "@/lib/notifications/discord";

const appOption = {
  type: 3,
  name: "app",
  description: "앱 slug",
  required: true,
  autocomplete: true,
};

export const DISCORD_COMMANDS = [
  { name: "help", description: "백오피스 명령 도움말", type: 1 },
  { name: "approvals", description: "승인 대기 항목", type: 1 },
  { name: "p1", description: "열린 P1 이슈", type: 1 },
  { name: "status", description: "앱 현황", type: 1, options: [{ ...appOption, required: false }] },
  { name: "metrics", description: "앱 지표", type: 1, options: [{ ...appOption, required: false }] },
  { name: "plan", description: "기획 초안 만들기", type: 1, options: [appOption] },
  { name: "bug", description: "버그 리포트 만들기", type: 1, options: [appOption] },
  {
    name: "release",
    description: "릴리즈 태그와 출시노트 생성",
    type: 1,
    options: [
      appOption,
      {
        type: 3,
        name: "bump",
        description: "SemVer 증가",
        required: true,
        choices: ["patch", "minor", "major"].map((name) => ({ name, value: name })),
      },
    ],
  },
  {
    name: "deploy",
    description: "릴리즈 태그를 마켓에 배포",
    type: 1,
    options: [
      appOption,
      { type: 3, name: "tag", description: "v1.2.3 형식", required: true },
      {
        type: 3,
        name: "target",
        description: "배포 대상",
        required: true,
        choices: ["AIT", "PLAY", "APPSTORE", "ALL"].map((name) => ({ name, value: name })),
      },
    ],
  },
  {
    name: "develop",
    description: "develop 후보 태그로 AppsInToss 빌드·배포",
    type: 1,
    options: [appOption],
  },
  { name: "save", description: "Obsidian 받은함에 메모 저장", type: 1 },
  { name: "index", description: "Obsidian 볼트 즉시 재인덱싱", type: 1 },
  { name: "ask", description: "백오피스 AI에게 질문", type: 1 },
  { name: "reset", description: "내 Discord 대화 문맥 초기화", type: 1 },
] as const;

export async function registerDiscordGuildCommands() {
  const appId = env.discordApplicationId();
  const guildId = env.discordGuildId();
  if (!/^\d+$/.test(appId) || !/^\d+$/.test(guildId) || !env.discordBotToken()) {
    throw new Error("Discord Application/Guild/Bot 설정이 없습니다.");
  }
  const result = await putDiscordApi(`/applications/${appId}/guilds/${guildId}/commands`, DISCORD_COMMANDS);
  if (!result.ok) throw new Error(result.error ?? "Discord command 등록 실패");
  return { commands: DISCORD_COMMANDS.length };
}
