import { prisma } from "@/lib/prisma";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { STAGE_KO, STAGES } from "@/lib/domain/lifecycle";
import { approvalIssueWhere, visibleAppWhere, visibleIssueWhere } from "@/lib/domain/app-visibility";
import { resolveGa4Target, isoDate } from "@/lib/ga4/datasets";
import { engagementRate, platformSegments, type MetricBreakdowns } from "@/lib/ga4/metric-shapes";
import type { DiscordActionRow } from "@/lib/notifications/discord";

export interface DiscordQueryResult {
  content: string;
  components?: DiscordActionRow[];
}

function pct(value: number | null): string {
  return value == null ? "—" : `${value}%`;
}

function clip(value: string, max = 1_900): string {
  return value.length <= max ? value : `${value.slice(0, max - 2)}…`;
}

export async function autocompleteApps(query: string) {
  const normalized = query.trim().toLowerCase();
  const apps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: { slug: true, displayName: true },
    take: 100,
  });
  return apps
    .filter((app) => !normalized || `${app.slug} ${app.displayName}`.toLowerCase().includes(normalized))
    .slice(0, 25)
    .map((app) => ({ name: `${app.displayName} (${app.slug})`.slice(0, 100), value: app.slug }));
}

export async function findVisibleApp(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/i.test(slug)) return null;
  return prisma.app.findFirst({
    where: { slug, ...visibleAppWhere },
    select: {
      id: true,
      slug: true,
      displayName: true,
      repoFullName: true,
      marketTargets: true,
      iosBundle: true,
    },
  });
}

export async function approvalsQuery(): Promise<DiscordQueryResult> {
  const open = await prisma.issueMirror.findMany({
    where: { ...approvalIssueWhere, state: "OPEN" },
    orderBy: [{ priority: "asc" }, { ghUpdatedAt: "desc" }],
    take: 500,
  });
  const pending = open.filter((issue) => {
    const labels = asStringArray(issue.labels);
    return hasApproval(labels, "planning") || hasApproval(labels, "release");
  });
  if (pending.length === 0) return { content: "✅ 승인 대기 없음" };

  const visible = pending.slice(0, 5);
  const components: DiscordActionRow[] = visible.map((issue) => {
    const gate = hasApproval(asStringArray(issue.labels), "release") ? "release" : "planning";
    return {
      type: 1,
      components: [{
        type: 2,
        style: 3,
        label: `${issue.repoFullName.replace("seorilabs/", "")} #${issue.number} 승인`.slice(0, 80),
        custom_id: `approval:${gate}:${issue.id}`,
      }],
    };
  });
  const lines = visible.map((issue) => {
    const gate = hasApproval(asStringArray(issue.labels), "release") ? "출시" : "기획";
    return `• **${issue.repoFullName.replace("seorilabs/", "")} #${issue.number}** · ${gate}\n  ${issue.title}`;
  });
  if (pending.length > visible.length) lines.push(`…외 ${pending.length - visible.length}건은 웹 백오피스에서 확인`);
  return { content: clip(`**승인 대기 ${pending.length}건**\n${lines.join("\n")}`), components };
}

export async function p1Query(): Promise<DiscordQueryResult> {
  const issues = await prisma.issueMirror.findMany({
    where: { ...visibleIssueWhere, state: "OPEN", priority: "P1" },
    orderBy: { ghUpdatedAt: "desc" },
    take: 20,
  });
  if (issues.length === 0) return { content: "✅ 열린 P1 이슈 없음" };
  return {
    content: clip(`**열린 P1 ${issues.length}건**\n${issues.map((issue) =>
      `• **${issue.repoFullName.replace("seorilabs/", "")} #${issue.number}** ${issue.title}`,
    ).join("\n")}`),
  };
}

export async function statusQuery(slug?: string): Promise<DiscordQueryResult> {
  if (!slug) {
    const apps = await prisma.app.findMany({
      where: visibleAppWhere,
      orderBy: [{ currentStage: "asc" }, { displayName: "asc" }],
      select: { displayName: true, slug: true, currentStage: true },
    });
    if (apps.length === 0) return { content: "등록된 앱이 없습니다." };
    const counts = new Map<string, number>();
    for (const app of apps) counts.set(app.currentStage, (counts.get(app.currentStage) ?? 0) + 1);
    const summary = STAGES.filter((stage) => counts.has(stage))
      .map((stage) => `${STAGE_KO[stage]} ${counts.get(stage)}`)
      .join(" · ");
    const list = apps.map((app) => `• **${app.displayName}** \`${app.slug}\` · ${STAGE_KO[app.currentStage]}`);
    return { content: clip(`**앱 ${apps.length}개**\n${summary}\n\n${list.join("\n")}`) };
  }

  const app = await prisma.app.findFirst({
    where: { slug, ...visibleAppWhere },
    include: {
      issues: { where: { state: "OPEN" }, select: { priority: true } },
      pullRequests: { where: { state: "OPEN" }, select: { id: true } },
      releases: { orderBy: { updatedAt: "desc" }, take: 1 },
    },
  });
  if (!app) return { content: `앱을 찾을 수 없습니다: \`${slug}\`` };
  const p1 = app.issues.filter((issue) => issue.priority === "P1").length;
  const release = app.releases[0];
  return {
    content: [
      `**${app.displayName}** · ${STAGE_KO[app.currentStage]}`,
      `타입 ${app.type}/${app.engine}`,
      `열린 이슈 ${app.issues.length} · P1 ${p1} · PR ${app.pullRequests.length}`,
      release ? `최근 릴리스 ${release.version} · ${release.market} · ${release.status}` : "릴리스 없음",
      `https://backoffice.vzyx.xyz/apps/${app.id}`,
    ].join("\n"),
  };
}

export async function metricsQuery(slug?: string): Promise<DiscordQueryResult> {
  if (!slug) {
    const all = await prisma.app.findMany({
      where: visibleAppWhere,
      orderBy: { displayName: "asc" },
      select: { id: true, slug: true, displayName: true, firebaseProject: true, ga4Dataset: true },
    });
    const apps = all.filter((app) => resolveGa4Target(app));
    if (apps.length === 0) return { content: "GA4 지표 대상 앱이 없습니다." };
    const rows = await Promise.all(apps.map(async (app) => ({
      app,
      latest: await prisma.appMetricDaily.findFirst({ where: { appId: app.id }, orderBy: { date: "desc" } }),
    })));
    return {
      content: clip(`**앱 지표 · 기준 D-1**\n${rows.map(({ app, latest }) => latest
        ? `• **${app.displayName}** \`${app.slug}\` · DAU ${latest.dau} · 신규 ${latest.newUsers} · D1 ${pct(latest.d1Pct)} · D7 ${pct(latest.d7Pct)} · ${isoDate(latest.date)}`
        : `• **${app.displayName}** \`${app.slug}\` · 수집 데이터 없음`).join("\n")}`),
    };
  }

  const app = await prisma.app.findFirst({
    where: { slug, ...visibleAppWhere },
    select: { id: true, slug: true, displayName: true, firebaseProject: true, ga4Dataset: true },
  });
  if (!app) return { content: `앱을 찾을 수 없습니다: \`${slug}\`` };
  const rows = await prisma.appMetricDaily.findMany({
    where: { appId: app.id },
    orderBy: { date: "desc" },
    take: 14,
  });
  if (rows.length === 0) {
    return { content: `**${app.displayName}**\n수집된 지표가 없습니다.${resolveGa4Target(app) ? "" : " GA4 매핑이 필요합니다."}` };
  }
  const latest = rows[0];
  const trend = rows.slice(0, 7).reverse().map((row) => `${isoDate(row.date).slice(5)} ${row.dau}`).join(" · ");
  const platform = platformSegments(latest.dauAndroid, latest.dauIos, latest.dauWeb)
    .segs.map((segment) => `${segment.label} ${segment.value}`).join(" · ");
  const raw = (latest.raw ?? {}) as MetricBreakdowns;
  const countries = (raw.countries ?? []).slice(0, 3).map((country) => `${country.k} ${country.dau}`).join(" · ");
  return {
    content: [
      `**${app.displayName}** · ${isoDate(latest.date)}`,
      `DAU **${latest.dau}** · 신규 ${latest.newUsers}`,
      `잔존 D1 ${pct(latest.d1Pct)} · D3 ${pct(latest.d3Pct)} · D7 ${pct(latest.d7Pct)}`,
      `활성 ${latest.engagedUsers} · 참여율 ${pct(engagementRate(latest.engagedUsers, latest.dau))}${latest.avgEngageSec == null ? "" : ` · 평균 ${latest.avgEngageSec}s`}`,
      platform ? `플랫폼 ${platform}` : null,
      countries ? `국가 ${countries}` : null,
      `광고 CTA ${latest.adCtaImpressions} · 완료 ${latest.adCompletions} · 네트워크 노출 ${latest.networkAdImpressions}`,
      `최근 DAU ${trend}`,
      `https://backoffice.vzyx.xyz/analytics?app=${app.slug}`,
    ].filter(Boolean).join("\n"),
  };
}
