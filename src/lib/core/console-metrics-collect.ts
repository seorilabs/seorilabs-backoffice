import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type {
  ConsoleMetricsPush,
  ConsoleAppPush,
  ConsoleDailyMetric,
} from "@/lib/analytics/console-source";

// AppsInToss 콘솔 지표 ingest(push 수집). 인증된 로컬 Claude 세션이 MCP dashboard_* 를 조회해
// 정규화한 push 페이로드를 받아 AppConsoleMetricDaily(앱×날짜)로 멱등 upsert 한다.
// GA4 수집(analytics-collect)과 대칭: 소스만 다르고(BigQuery pull ↔ MCP push) 저장 규약은 동일.
// App 해석은 slug 우선(항상 존재), 없으면 aitMiniAppId. 매핑 실패/유효하지 않은 날짜는 개별
// skip/error 로 담고 나머지 수집은 계속한다(부분 실패 격리).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS_PER_APP = 120; // 한 앱 push 당 날짜 상한(폭주 방지)

export interface ConsoleIngestResult {
  targetApps: number; // 해석에 성공해 수집된 앱 수
  upserts: number; // 저장된 (앱×날짜) row 수
  skipped: { key: string; reason: string }[]; // 매핑/유효성 실패로 제외
  errors: { key: string; error: string }[]; // upsert 중 예외
}

/** "YYYY-MM-DD"(UTC 자정) Date 로 파싱. @db.Date 저장/비교용. */
function parseIsoDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function pushKey(p: ConsoleAppPush): string {
  return p.slug ?? (p.miniAppId != null ? `miniApp:${p.miniAppId}` : "unknown");
}

/**
 * push 페이로드를 검증·해석해 upsert 한다.
 * @param payload ingest route 가 받은 raw body(외부 입력이므로 방어적으로 검증).
 * @param now collectedAt 기준 시각.
 */
export async function ingestConsoleMetrics(
  payload: unknown,
  now: Date,
): Promise<ConsoleIngestResult> {
  const result: ConsoleIngestResult = {
    targetApps: 0,
    upserts: 0,
    skipped: [],
    errors: [],
  };

  const apps = (payload as ConsoleMetricsPush | null)?.apps;
  if (!Array.isArray(apps) || apps.length === 0) {
    throw new Error("잘못된 페이로드 — { apps: ConsoleAppPush[] } 필요");
  }

  // App 해석 인덱스(slug / aitMiniAppId). 한 번만 로드.
  const registry = await prisma.app.findMany({
    select: { id: true, slug: true, aitMiniAppId: true },
  });
  const bySlug = new Map(registry.map((a) => [a.slug, a]));
  const byMiniApp = new Map(
    registry.filter((a) => a.aitMiniAppId != null).map((a) => [a.aitMiniAppId as number, a]),
  );

  for (const push of apps) {
    const key = pushKey(push);
    const app =
      (push.slug ? bySlug.get(push.slug) : undefined) ??
      (push.miniAppId != null ? byMiniApp.get(push.miniAppId) : undefined);
    if (!app) {
      result.skipped.push({ key, reason: "App 매핑 없음(slug/aitMiniAppId 불일치)" });
      continue;
    }
    if (!Array.isArray(push.days) || push.days.length === 0) {
      result.skipped.push({ key, reason: "days 비어있음" });
      continue;
    }
    if (push.days.length > MAX_DAYS_PER_APP) {
      result.skipped.push({ key, reason: `days 초과(${push.days.length} > ${MAX_DAYS_PER_APP})` });
      continue;
    }

    result.targetApps++;
    for (const day of push.days as ConsoleDailyMetric[]) {
      if (!day || typeof day.date !== "string" || !ISO_DATE.test(day.date)) {
        result.errors.push({ key, error: `잘못된 date: ${day?.date}` });
        continue;
      }
      const date = parseIsoDate(day.date);
      const data = {
        dau: num(day.dau),
        newUsers: num(day.newUsers),
        avgSessionSec:
          day.avgSessionSec == null ? null : num(day.avgSessionSec, 0),
        iaaImpressions: num(day.iaaImpressions),
        iaaEarningKrw: num(day.iaaEarningKrw),
        iapTrxAmountKrw: num(day.iapTrxAmountKrw),
        iapSettlementKrw: num(day.iapSettlementKrw),
        payingUsers: num(day.payingUsers),
        raw: (day.raw ?? Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
        collectedAt: now,
      };
      try {
        await prisma.appConsoleMetricDaily.upsert({
          where: { appId_date: { appId: app.id, date } },
          create: { appId: app.id, date, ...data },
          update: data,
        });
        result.upserts++;
      } catch (e) {
        result.errors.push({ key: `${key}@${day.date}`, error: (e as Error).message.slice(0, 300) });
      }
    }
  }

  return result;
}
