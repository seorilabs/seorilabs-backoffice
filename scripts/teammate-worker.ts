import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  DiscordGatewayConnection,
  fetchGatewayUrl,
  GATEWAY_INTENT_GUILDS,
  GATEWAY_INTENT_GUILD_MESSAGES,
} from "@/lib/discord/gateway";
import {
  configuredTeammates,
  type GatewayMessage,
  shouldHandleTeammateMention,
  stripMentionTags,
  type TeammateMeta,
} from "@/lib/discord/teammates";
import {
  handleTeammateMention,
  processNextTeammateMentionRetry,
} from "@/lib/discord/teammate-chat";
import { maintainTeammateRuns, processNextTeammatePatrol } from "@/lib/discord/teammate-patrol";

// 팀원별 동시 처리 상한. 초과분은 Gemini 없이 혼잡 답변으로 즉시 응답한다.
const MAX_PENDING_PER_TEAMMATE = 2;

let stopping = false;

function stop(): void {
  stopping = true;
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini 전역 직렬화(semaphore 1). LLM 쓰는 팀원들이 무료 쿼타를 동시에 태우지 않게 한다.
let geminiChain: Promise<void> = Promise.resolve();

function withGeminiSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = geminiChain.then(() => fn());
  geminiChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface TeammateConnection {
  meta: TeammateMeta;
  botToken: string;
  botUserId: string;
  pending: number;
  connection: DiscordGatewayConnection;
}

function onMessageCreate(state: TeammateConnection, guildId: string, data: unknown): void {
  const message = (data ?? {}) as GatewayMessage;
  if (!shouldHandleTeammateMention(message, state.botUserId, guildId)) return;
  const channelId = message.channel_id;
  const authorId = message.author?.id;
  const messageId = message.id;
  if (!channelId || !authorId || !messageId) return;
  const busy = state.pending >= MAX_PENDING_PER_TEAMMATE;
  state.pending += 1;
  const input = {
    meta: state.meta,
    guildId,
    channelId,
    userId: authorId,
    messageId,
    text: stripMentionTags(message.content ?? "", state.botUserId),
    botToken: state.botToken,
    busy,
  };
  // 혼잡 답변은 Gemini 를 쓰지 않으므로 슬롯 없이 즉시 보낸다.
  const task = busy ? handleTeammateMention(input) : withGeminiSlot(() => handleTeammateMention(input));
  task
    .catch((error) => {
      console.error(
        `[teammate-worker:${state.meta.key}] 멘션 처리 실패:`,
        error instanceof Error ? error.message : "error",
      );
    })
    .finally(() => {
      state.pending -= 1;
    });
}

async function connectTeammate(meta: TeammateMeta, guildId: string): Promise<TeammateConnection> {
  const botToken = env.discordTeammateBotToken(meta.key);
  const gatewayUrl = await fetchGatewayUrl(botToken);
  const state: TeammateConnection = {
    meta,
    botToken,
    botUserId: "",
    pending: 0,
    connection: undefined as unknown as DiscordGatewayConnection,
  };
  state.connection = new DiscordGatewayConnection({
    token: botToken,
    intents: GATEWAY_INTENT_GUILDS | GATEWAY_INTENT_GUILD_MESSAGES,
    gatewayUrl,
    label: meta.key,
    handlers: {
      onReady: ({ botUserId }) => {
        state.botUserId = botUserId;
      },
      onDispatch: (type, data) => {
        if (type === "MESSAGE_CREATE") onMessageCreate(state, guildId, data);
      },
    },
  });
  state.connection.start();
  return state;
}

async function main(): Promise<void> {
  const teammates = configuredTeammates();
  const guildId = env.discordGuildId();
  if (teammates.length === 0 || !guildId) {
    // 자격증명 없이도 배포가 깨지지 않도록 crashloop 대신 idle 로 대기한다.
    console.log("[teammate-worker] 활성화된 팀원이 없어 idle 상태로 대기합니다.");
    while (!stopping) await sleep(1_000);
    return;
  }

  const connections: TeammateConnection[] = [];
  for (const meta of teammates) {
    try {
      connections.push(await connectTeammate(meta, guildId));
      console.log(`[teammate-worker] ${meta.ko}(${meta.key}) Gateway 연결 시작`);
    } catch (error) {
      // 토큰 하나가 잘못돼도 나머지 팀원은 계속 일해야 한다. 실패 팀원은
      // 로그로 드러내고 다음 Pod 재시작 때 재시도된다.
      console.error(
        `[teammate-worker] ${meta.key} 연결 실패:`,
        error instanceof Error ? error.message : "error",
      );
    }
  }
  if (connections.length === 0) throw new Error("팀원 Gateway 연결이 모두 실패했습니다.");

  // 순찰 큐(teammate_run PENDING)는 60초 주기로 직렬 소화한다. Gemini 종합은
  // 멘션과 같은 전역 슬롯을 지나므로 무료 쿼타 동시 소진이 없다.
  let lastPatrolTick = 0;
  while (!stopping) {
    if (Date.now() - lastPatrolTick >= 60_000) {
      lastPatrolTick = Date.now();
      try {
        await maintainTeammateRuns();
        while (!stopping && (await processNextTeammateMentionRetry(withGeminiSlot))) {
          // maintain 이 PENDING 으로 되돌린 멘션을 순찰보다 먼저 소화한다(사람이 기다리는 중).
        }
        while (!stopping && (await processNextTeammatePatrol(withGeminiSlot))) {
          // 다음 PENDING 순찰이 없어질 때까지 1건씩 처리
        }
      } catch (error) {
        console.error(
          "[teammate-worker] 순찰 처리 실패:",
          error instanceof Error ? error.message : "error",
        );
      }
    }
    await sleep(1_000);
  }
  for (const state of connections) state.connection.stop();
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("[teammate-worker] 실패:", error instanceof Error ? error.message : "error");
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
