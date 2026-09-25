import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { discordDestinations } from "@/lib/notifications/destinations";
import { EMBED_COLOR } from "@/lib/notifications/style";

const BUCKET_MS = 5 * 60_000;
const BASELINE_MS = 24 * 60 * 60_000;
const MIN_SAMPLES = 12;

export interface SpikeState {
  active: boolean;
  highStreak: number;
  lowStreak: number;
  highStartedAt: Date | null;
  lastSampleAt: Date | null;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function decideRealtimeSpike(input: {
  current: number;
  history: number[];
  bucketAt: Date;
  previous: SpikeState | null;
}): { state: SpikeState; alert: boolean; baseline: number | null } {
  const previous = input.previous;
  const consecutive = previous?.lastSampleAt != null &&
    input.bucketAt.getTime() - previous.lastSampleAt.getTime() === BUCKET_MS;
  const baseline = input.history.length >= MIN_SAMPLES ? median(input.history) : null;
  if (baseline === null) {
    return { baseline, alert: false, state: {
      active: previous?.active ?? false,
      highStreak: 0,
      lowStreak: 0,
      highStartedAt: null,
      lastSampleAt: input.bucketAt,
    } };
  }
  const high = baseline !== null && input.current >= 10 &&
    input.current >= 3 * Math.max(1, baseline);
  let active = previous?.active ?? false;
  const highStreak = high ? (consecutive ? previous?.highStreak ?? 0 : 0) + 1 : 0;
  const lowStreak = !high && active ? (consecutive ? previous?.lowStreak ?? 0 : 0) + 1 : 0;
  const alert = !active && highStreak >= 2;
  if (alert) active = true;
  if (active && lowStreak >= 3) active = false;
  return {
    baseline,
    alert,
    state: {
      active,
      highStreak: active ? 0 : highStreak,
      lowStreak: active ? lowStreak : 0,
      highStartedAt: high
        ? consecutive && previous?.highStartedAt ? previous.highStartedAt : input.bucketAt
        : null,
      lastSampleAt: input.bucketAt,
    },
  };
}

export async function recordRealtimeActivity(input: {
  appId: string;
  displayName: string;
  activeUsers: number;
  bucketAt: Date;
}): Promise<"sampled" | "alerted" | "duplicate"> {
  if (!Number.isSafeInteger(input.activeUsers) || input.activeUsers < 0) {
    throw new Error("GA4 활성 사용자 수 형식 오류");
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const history = await tx.realtimeActivitySample.findMany({
          where: {
            appId: input.appId,
            bucketAt: { gte: new Date(input.bucketAt.getTime() - BASELINE_MS), lt: input.bucketAt },
          },
          select: { activeUsers: true },
          orderBy: { bucketAt: "desc" },
          take: 288,
        });
      const previous = await tx.realtimeActivitySpikeState.findUnique({ where: { appId: input.appId } });
      await tx.realtimeActivitySample.create({
        data: { appId: input.appId, bucketAt: input.bucketAt, activeUsers: input.activeUsers },
      });
      const decision = decideRealtimeSpike({
        current: input.activeUsers,
        history: history.map((row) => row.activeUsers),
        bucketAt: input.bucketAt,
        previous,
      });
      await tx.realtimeActivitySpikeState.upsert({
        where: { appId: input.appId },
        create: {
          appId: input.appId,
          ...decision.state,
          lastAlertAt: decision.alert ? input.bucketAt : null,
        },
        update: {
          ...decision.state,
          ...(decision.alert ? { lastAlertAt: input.bucketAt } : {}),
        },
      });
      if (decision.alert) {
        await enqueueNotification({
          dedupeKey: `ga4-spike:${input.appId}:${input.bucketAt.toISOString()}`,
          kind: "OPERATIONAL_EVENT",
          occurredAt: input.bucketAt,
          payload: {
            text: `최근 5분 활성 사용자 ${input.activeUsers}명\n평소 수준 ${decision.baseline}명 · ${Math.round(input.activeUsers / Math.max(1, decision.baseline!))}배`,
            embed: {
              title: `📈 ${input.displayName} · 활성 사용자 급증`,
              color: EMBED_COLOR.WARNING,
              timestamp: input.bucketAt.toISOString(),
            },
          },
          destinations: discordDestinations(["app-ops"]),
        }, tx);
      }
      return decision.alert ? "alerted" : "sampled";
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "duplicate";
    }
    throw error;
  }
}

export async function purgeRealtimeActivitySamples(now = new Date()): Promise<number> {
  const result = await prisma.realtimeActivitySample.deleteMany({
    where: { bucketAt: { lt: new Date(now.getTime() - BASELINE_MS - BUCKET_MS) } },
  });
  return result.count;
}
