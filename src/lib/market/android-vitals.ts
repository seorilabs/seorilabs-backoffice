import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  getGoogleAccessToken,
  type GoogleServiceAccountClaims,
} from "@/lib/google-play/service-account";
import { observedCollection } from "@/lib/insights/collection";
import { metricDayOf, toDbDay } from "@/lib/analytics/metric-day";
import { boundedText } from "./public-sources";

const dateTime = z
  .object({
    year: z.number().int(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  })
  .passthrough();
export function vitalsWindow(end: z.infer<typeof dateTime>) {
  const start = new Date(Date.UTC(end.year, end.month - 1, end.day - 1));
  return {
    aggregationPeriod: "DAILY",
    startTime: {
      year: start.getUTCFullYear(),
      month: start.getUTCMonth() + 1,
      day: start.getUTCDate(),
      timeZone: { id: "America/Los_Angeles" },
    },
    endTime: {
      year: end.year,
      month: end.month,
      day: end.day,
      timeZone: { id: "America/Los_Angeles" },
    },
  };
}
export async function fetchVitals(input: {
  packageName: string;
  claims: GoogleServiceAccountClaims;
  fetchImpl?: typeof fetch;
}) {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(input.packageName))
    throw new Error("INVALID_PACKAGE");
  const fetchImpl = input.fetchImpl ?? fetch;
  const { token } = await getGoogleAccessToken({
    claims: input.claims,
    scope: "https://www.googleapis.com/auth/playdeveloperreporting",
    fetchImpl,
  });
  const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
  const result: Array<{
    metricSet: string;
    cohort: string;
    period: ReturnType<typeof vitalsWindow>;
    rows: unknown[];
  }> = [];
  for (const [metricSet, metric] of [
    ["crashRateMetricSet", "userPerceivedCrashRate"],
    ["anrRateMetricSet", "userPerceivedAnrRate"],
  ]) {
    const endpoint =
      "https://playdeveloperreporting.googleapis.com/v1beta1/apps/" +
      input.packageName +
      "/" +
      metricSet;
    const metadata = await fetchImpl(endpoint, {
      headers,
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!metadata.ok) throw new Error("Vitals metadata HTTP " + metadata.status);
    const info = z
      .object({
        freshnessInfo: z.object({
          freshnesses: z.array(
            z.object({ aggregationPeriod: z.string(), latestEndTime: dateTime }),
          ),
        }),
      })
      .parse(JSON.parse(await boundedText(metadata)));
    const end = info.freshnessInfo.freshnesses.find(
      (row) => row.aggregationPeriod === "DAILY",
    )?.latestEndTime;
    if (!end) continue;
    for (const cohort of ["OS_PUBLIC", "APP_TESTERS"]) {
      const rows: unknown[] = [];
      let pageToken = "";
      for (let page = 0; page < 10; page++) {
        const response = await fetchImpl(endpoint + ":query", {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(20_000),
          redirect: "error",
          body: JSON.stringify({
            timelineSpec: vitalsWindow(end),
            metrics: [metric, "distinctUsers"],
            dimensions: ["versionCode", "countryCode"],
            userCohort: cohort,
            pageSize: 1000,
            ...(pageToken ? { pageToken } : {}),
          }),
        });
        if (!response.ok) throw new Error("Vitals query HTTP " + response.status);
        const data = z
          .object({
            rows: z.array(z.unknown()).max(1000).default([]),
            nextPageToken: z.string().optional(),
          })
          .parse(JSON.parse(await boundedText(response)));
        rows.push(...data.rows);
        pageToken = data.nextPageToken ?? "";
        if (!pageToken) break;
      }
      if (pageToken) throw new Error("Vitals pagination incomplete");
      result.push({ metricSet, cohort, period: vitalsWindow(end), rows });
    }
  }
  return result;
}
export async function collectAndroidVitals(now = new Date()) {
  const apps = await prisma.app.findMany({
    where: { status: "ACTIVE", playPackage: { not: null } },
    select: { id: true, playPackage: true },
  });
  let succeeded = 0,
    failed = 0;
  for (const app of apps)
    try {
      await observedCollection(
        { source: "android-vitals", target: app.playPackage!, appId: app.id },
        async () => {
          const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
          if (!raw) throw new Error("Vitals 자격증명 미설정");
          const result = await fetchVitals({
            packageName: app.playPackage!,
            claims: JSON.parse(raw) as GoogleServiceAccountClaims,
          });
          const value = { timezone: "America/Los_Angeles", slices: result };
          const day = toDbDay(metricDayOf(now));
          const sourceUrl = "https://play.google.com/console/developers";
          await prisma.marketObservation.upsert({
            where: {
              appId_kind_target_country_day: {
                appId: app.id,
                kind: "android-vitals",
                target: app.playPackage!,
                country: "global",
                day,
              },
            },
            create: {
              appId: app.id,
              kind: "android-vitals",
              target: app.playPackage!,
              country: "global",
              day,
              sourceUrl,
              value: value as unknown as Prisma.InputJsonValue,
              observedAt: now,
            },
            update: { value: value as unknown as Prisma.InputJsonValue, observedAt: now },
          });
          const through = result.map((slice) => vitalsDataThrough(slice.period.endTime));
          return {
            value: null,
            dataThrough: through.length
              ? new Date(Math.min(...through.map((date) => date.getTime())))
              : undefined,
            count: result.reduce((count, slice) => count + slice.rows.length, 0),
          };
        },
      );
      succeeded++;
    } catch {
      failed++;
    }
  return { succeeded, failed };
}

/** Provider 달력의 LA 자정. UTC 자정으로 저장하거나 DST 전환일을 추측하지 않는다. */
export function vitalsDataThrough(end: { year: number; month: number; day: number }) {
  const target = Date.UTC(end.year, end.month - 1, end.day);
  let instant = target + 8 * 3600000;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(
      fmt.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    const actual = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    if (actual === target) return new Date(instant);
    instant += target - actual;
  }
  throw new Error("VITALS_PROVIDER_DATE_INVALID");
}
