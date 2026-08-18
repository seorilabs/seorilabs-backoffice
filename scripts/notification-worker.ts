import { connect, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  OPS_NOTIFICATION_SUBJECT_PREFIX,
  type NotificationAck,
} from "@/lib/notifications/external-contract";
import { ingestExternalNotification } from "@/lib/notifications/external-ingest";
import { drainAllNotifications } from "@/lib/notifications/deploy";
import { maintainDiscordRetention } from "@/lib/notifications/retention";

const encoder = new TextEncoder();
const pollIntervalMs = Math.max(250, Number(process.env.NOTIFICATION_POLL_INTERVAL_MS ?? "1000"));
let stopping = false;
let subscription: Subscription | null = null;
let connection: NatsConnection | null = null;

function stop(): void {
  stopping = true;
  subscription?.unsubscribe();
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "invalid notification").slice(0, 300);
}

async function consume(): Promise<void> {
  connection = await connect({
    servers: env.natsServerUrl(),
    name: "seorilabs-backoffice-notification-worker",
    maxReconnectAttempts: -1,
  });
  subscription = connection.subscribe(`${OPS_NOTIFICATION_SUBJECT_PREFIX}.>`, {
    queue: "seorilabs-backoffice-notifications",
  });
  console.log("[notification-worker] NATS 구독 시작");
  for await (const message of subscription) {
    try {
      const ack = await ingestExternalNotification(message.subject, message.json<unknown>());
      message.respond(encoder.encode(JSON.stringify(ack)));
    } catch (error) {
      message.respond(encoder.encode(JSON.stringify({ accepted: false, error: safeError(error) } satisfies NotificationAck)));
    }
  }
}

async function deliver(): Promise<void> {
  let lastRetention = 0;
  while (!stopping) {
    if (Date.now() - lastRetention >= 24 * 60 * 60_000) {
      const retained = await maintainDiscordRetention();
      if (retained.deletedNotifications || retained.deletedCommands || retained.deletedTurns) {
        console.log(`[notification-worker] 보존기한 정리 알림 ${retained.deletedNotifications} · 명령 ${retained.deletedCommands} · 대화 ${retained.deletedTurns}`);
      }
      lastRetention = Date.now();
    }
    const result = await drainAllNotifications();
    if (result.deadLetter > 0) console.error(`[notification-worker] dead letter ${result.deadLetter}건`);
    if (result.processed === 0) await sleep(pollIntervalMs);
  }
}

async function main(): Promise<void> {
  const delivery = deliver();
  try {
    await consume();
  } finally {
    stopping = true;
    await delivery;
    if (connection && !connection.isClosed()) await connection.drain();
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("[notification-worker] 실패:", safeError(error));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
