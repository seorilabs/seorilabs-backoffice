import { prisma } from "@/lib/prisma";
import { asStringArray, daysSince } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import type { Lifecycle } from "@prisma/client";

export type MarketStatus = "succeeded" | "failed" | "pending" | "none";

export interface BoardApp {
  id: string;
  slug: string;
  displayName: string;
  type: "APP" | "GAME";
  engine: "RN" | "GODOT";
  stage: Lifecycle;
  status: "ACTIVE" | "PAUSED" | "DEPRECATED";
  marketTargets: string[];
  openIssues: number;
  openPrs: number;
  p1: number;
  p2: number;
  blocked: boolean;
  approvalWaiting: boolean;
  needsConfig: boolean;
  stagnationDays: number | null;
  marketStatus: Record<string, MarketStatus>;
  latestRelease: { version: string; deployedAt: Date | null } | null;
}

function marketStatusOf(
  releases: { market: string; status: string; deployedAt: Date | null }[],
  market: string,
): MarketStatus {
  const enumName = market.toUpperCase();
  const forMarket = releases.filter((r) => r.market === enumName);
  if (forMarket.length === 0) return "none";
  if (forMarket.some((r) => r.status === "SUCCEEDED")) return "succeeded";
  if (forMarket.some((r) => r.status === "FAILED")) return "failed";
  return "pending";
}

export async function getBoardApps(): Promise<BoardApp[]> {
  const apps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: [{ type: "asc" }, { displayName: "asc" }],
    include: {
      issues: {
        where: { state: "OPEN" },
        select: { priority: true, isBlocked: true, labels: true },
      },
      pullRequests: { where: { state: "OPEN" }, select: { id: true } },
      releases: { select: { market: true, status: true, deployedAt: true, version: true } },
      transitions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
    },
  });

  return apps.map((a) => {
    const openIssues = a.issues.length;
    const p1 = a.issues.filter((i) => i.priority === "P1").length;
    const p2 = a.issues.filter((i) => i.priority === "P2").length;
    const blocked = a.issues.some((i) => i.isBlocked);
    const approvalWaiting = a.issues.some((i) => {
      const labels = asStringArray(i.labels);
      return hasApproval(labels, "planning") || hasApproval(labels, "release");
    });
    const marketTargets = asStringArray(a.marketTargets);
    const marketStatus: Record<string, MarketStatus> = {};
    for (const m of marketTargets) marketStatus[m] = marketStatusOf(a.releases, m);

    const succeededReleases = a.releases
      .filter((r): r is typeof r & { deployedAt: Date } => r.deployedAt != null)
      .sort((x, y) => y.deployedAt.getTime() - x.deployedAt.getTime());
    const latestRelease = succeededReleases[0]
      ? { version: succeededReleases[0].version, deployedAt: succeededReleases[0].deployedAt }
      : null;

    const needsConfig =
      marketTargets.includes("play") && !a.playPackage
        ? true
        : marketTargets.includes("appstore") && !a.iosBundle
          ? true
          : false;

    const lastTransition = a.transitions[0]?.createdAt ?? a.createdAt;

    return {
      id: a.id,
      slug: a.slug,
      displayName: a.displayName,
      type: a.type,
      engine: a.engine,
      stage: a.currentStage,
      status: a.status,
      marketTargets,
      openIssues,
      openPrs: a.pullRequests.length,
      p1,
      p2,
      blocked,
      approvalWaiting,
      needsConfig,
      stagnationDays: daysSince(lastTransition),
      marketStatus,
      latestRelease,
    };
  });
}
