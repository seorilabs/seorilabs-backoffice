import { publicLinkTarget } from "@/lib/market/support-links";
import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { lastElapsedMetricDay, toDbDay } from "@/lib/analytics/metric-day";
import { resolveGa4Target } from "@/lib/ga4/datasets";
import { resolveAitTarget } from "@/lib/analytics/ait-apps";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { sourceStateLabel, collectionTarget } from "./collection";

export async function feedbackOverview(appId?: string) {
  const apps = await prisma.app.findMany({
    where: { ...visibleAppWhere, ...(appId ? { id: appId } : {}) },
    select: { id: true, displayName: true },
  });
  const ids = apps.map((app) => app.id);
  const [reviews, market, insights] = await Promise.all([
    prisma.storeReviewObservation.findMany({
      where: { appId: { in: ids } },
      orderBy: { lastObservedAt: "desc" },
      take: 40,
    }),
    prisma.marketObservation.findMany({
      where: { appId: { in: ids } },
      orderBy: [{ day: "desc" }, { kind: "asc" }],
      take: 100,
    }),
    prisma.insightDocument.findMany({
      where: { signal: { OR: [{ appId: { in: ids } }, ...(!appId ? [{ appId: null }] : [])] } },
      include: { signal: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);
  return { apps, reviews, market, insights };
}
export async function sourceHealth(appId?: string) {
  const apps = await prisma.app.findMany({
    where: { ...visibleAppWhere, ...(appId ? { id: appId } : {}) },
    select: {
      id: true,
      displayName: true,
      slug: true,
      status: true,
      currentStage: true,
      marketTargets: true,
      iosBundle: true,
      playPackage: true,
      firebaseProject: true,
      ga4Dataset: true,
      aitWorkspaceId: true,
      aitMiniAppId: true,
      configRevisions: { where: { status: "ACTIVE" }, orderBy: { revision: "desc" }, take: 1 },
    },
  });
  const ids = apps.map((app) => app.id);
  const day = lastElapsedMetricDay(new Date());
  const [attempts, ledger] = await Promise.all([
    prisma.sourceCollectionRun.findMany({
      where: { OR: [{ appId: { in: ids } }, { appId: null }] },
      orderBy: { startedAt: "desc" },
      take: 2000,
    }),
    prisma.metricCollectionLedger.findMany({
      where: { appId: { in: ids }, day: toDbDay(day) },
      orderBy: { observedAt: "desc" },
    }),
  ]);
  const seen = new Set<string>();
  const rows: Array<{
    key: string;
    source: string;
    target: string;
    appId: string | null;
    state: string;
    label: string;
    dataThrough: Date | null;
    attemptedAt: Date | null;
    errorCode: string | null;
  }> = attempts.flatMap((run) => {
    const key = `${run.source}:${run.appId ?? "global"}:${run.target}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const threshold =
      run.source === "play-submissions"
        ? 60 * 60_000
        : run.source.startsWith("reviews:")
          ? 2 * 60 * 60_000
          : 48 * 60 * 60_000;
    const status =
      ["observed", "empty"].includes(run.status) && Date.now() - Math.min(run.startedAt.getTime(),run.dataThrough?.getTime()??run.startedAt.getTime()) > threshold
        ? "stale"
        : run.status === "running" && Date.now() - run.startedAt.getTime() > 30 * 60_000
          ? "failed"
          : run.status;
    return [
      {
        key,
        source: run.source,
        target: run.target,
        appId: run.appId,
        state: status,
        label: sourceStateLabel(status),
        dataThrough:
          run.dataThrough ??
          attempts.find(
            (previous) =>
              previous.source === run.source &&
              previous.appId === run.appId &&
              previous.target === run.target &&
              ["observed", "empty"].includes(previous.status),
          )?.dataThrough ??
          null,
        attemptedAt: run.startedAt,
        errorCode: run.errorCode,
      },
    ];
  });
  for (const app of apps)
    for (const [source, applicable] of [
      ["ga4", Boolean(resolveGa4Target(app))],
      ["ait_console", Boolean(resolveAitTarget(app))],
    ] as const) {
      const entries = ledger.filter((entry) => entry.appId === app.id && entry.source === source);
      if (!entries.length)
        rows.push({
          key: `${source}:${app.id}`,
          source,
          target: app.displayName,
          appId: app.id,
          state: applicable ? "not_landed" : "not_applicable",
          label: sourceStateLabel(applicable ? "not_landed" : "not_applicable"),
          dataThrough: null,
          attemptedAt: null,
          errorCode: null,
        });
      for (const entry of entries)
        rows.push({
          key: `${source}:${app.id}:${entry.listingId}`,
          source,
          target: `${app.displayName}${entry.listingId ? ` · ${entry.listingId}` : ""}`,
          appId: app.id,
          state: entry.state,
          label: sourceStateLabel(entry.state),
          dataThrough: entry.state === "observed" || entry.state === "empty" ? entry.day : null,
          attemptedAt: entry.observedAt,
          errorCode: entry.state === "failed" ? "METRIC_COLLECTION_FAILED" : null,
        });
    }
  for (const app of apps) {
    const expected: Array<[string, string, boolean, boolean?]> = [];
    const markets = Array.isArray(app.marketTargets) ? app.marketTargets : [];
    const reviewable = app.status === "ACTIVE" && ["RELEASE", "LIVEOPS"].includes(app.currentStage);
    if (app.playPackage)
      expected.push(
        ["play-submissions", app.playPackage, true],
        ["reviews:GOOGLE_PLAY", app.id, true, reviewable && markets.includes("play")],
        ["android-vitals", app.playPackage, true, app.status === "ACTIVE"],
      );
    if (app.iosBundle)
      expected.push([
        "reviews:APP_STORE",
        app.id,
        true,
        reviewable && markets.includes("appstore"),
      ]);
    const parsed = configRevisionPayloadSchema.safeParse(app.configRevisions[0]?.payload);
    const monitoring = parsed.success ? parsed.data.monitoring : undefined;
    if (monitoring?.enabled) {
      for (const country of monitoring.countries) {
        if (app.iosBundle)
          expected.push(["apple-public-lookup", app.iosBundle + ":" + country, true]);
        for (const term of monitoring.keywords)
          expected.push(["apple-keyword", country + ":" + term, Boolean(app.iosBundle)]);
        for (const id of monitoring.competitorAppIds)
          expected.push(["apple-competitor", id + ":" + country, true]);
      }
      for (const feed of monitoring.officialFeeds) {
        if (!rows.some((row) => row.source === "official-policy-feed" && row.target === feed))
          expected.push(["official-policy-feed", feed, true]);
      }
      if (monitoring.checkSupportLinks && parsed.success) {
        const links = [
          parsed.data.support?.supportUrl,
          parsed.data.support?.privacyPolicyUrl,
        ].filter((url): url is string => Boolean(url));
        for (const url of links.length ? links : ["지원·개인정보 링크 미설정"])
          expected.push([
            "support-link",
            links.length ? publicLinkTarget(url) : url,
            links.length > 0,
          ]);
      }
    }
    for (const [source, rawTarget, configured, applicable] of expected) {
      const target = collectionTarget(rawTarget);
      if (
        rows.some(
          (row) =>
            row.source === source &&
            row.target === target &&
            (row.appId === app.id || row.appId === null),
        )
      )
        continue;
      const state =
        applicable === false ? "not_applicable" : configured ? "not_landed" : "needs_input";
      rows.push({
        key: source + ":" + app.id + ":" + target,
        source,
        target,
        appId: app.id,
        state,
        label: sourceStateLabel(state),
        dataThrough: null,
        attemptedAt: null,
        errorCode: configured ? null : "SOURCE_CONFIGURATION_REQUIRED",
      });
    }
  }
  return { apps, day, rows };
}
export async function pendingWork() {
  const [issues, approvals, incidents, failed] = await Promise.all([
    prisma.issueMirror.findMany({
      where: { state: "OPEN", priority: "P1", app: { is: visibleAppWhere } },
      orderBy: { ghUpdatedAt: "desc" },
      take: 8,
    }),
    prisma.deploymentApproval.count({ where: { providerState: "WAITING" } }),
    prisma.operationalIncident.findMany({
      where: { status: { not: "RECOVERED" } },
      orderBy: { lastDetectedAt: "desc" },
      take: 5,
    }),
    prisma.agentRun.count({ where: { status: "DEAD_LETTER" } }),
  ]);
  return { issues, approvals, incidents, failed };
}
