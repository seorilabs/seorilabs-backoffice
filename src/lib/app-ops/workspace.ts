import { resolveAitTarget } from "@/lib/analytics/ait-apps";
import { resolveGa4Target } from "@/lib/ga4/datasets";
import { resolveAppContentSpec } from "@/lib/app-ops/content-spec";
import {
  parseAppOpsManifest,
  toolsForSection,
  type AppOpsSection,
} from "@/lib/app-ops/manifest";

export const APP_WORKSPACE_TABS = [
  { key: "overview", segment: "", label: "개요" },
  { key: "metrics", segment: "metrics", label: "지표" },
  { key: "operations", segment: "operations", label: "운영" },
  { key: "commerce", segment: "commerce", label: "앱 내 결제" },
  { key: "ads", segment: "ads", label: "광고" },
  { key: "content", segment: "content", label: "콘텐츠" },
  { key: "flags", segment: "flags", label: "기능 켜기·끄기" },
  { key: "fleet", segment: "fleet", label: "앱 통합 관리" },
  { key: "development", segment: "development", label: "개발" },
  { key: "releases", segment: "releases", label: "릴리스" },
] as const;

export type AppWorkspaceTabKey = (typeof APP_WORKSPACE_TABS)[number]["key"];
export type AppWorkspaceReadiness = "ready" | "partial" | "missing";

export interface AppWorkspaceSource {
  id: string;
  slug: string;
  repoId: bigint | null;
  firebaseProject: string | null;
  ga4Dataset: string | null;
  aitWorkspaceId: number | null;
  aitMiniAppId: number | null;
  opsManifest: unknown;
  opsManifestError: string | null;
}

export interface AppWorkspaceTab {
  key: AppWorkspaceTabKey;
  label: string;
  href: string;
  readiness: AppWorkspaceReadiness;
}

function toolReadiness(app: AppWorkspaceSource, section: AppOpsSection): AppWorkspaceReadiness {
  if (app.opsManifestError) return "partial";
  return toolsForSection(app.opsManifest, section).length > 0 ? "ready" : "missing";
}

export function buildAppWorkspaceTabs(app: AppWorkspaceSource): AppWorkspaceTab[] {
  const base = `/apps/${app.id}`;
  const hasGa4 = Boolean(resolveGa4Target(app));
  const hasConsole = Boolean(resolveAitTarget(app));
  const contentSpec = resolveAppContentSpec(app.slug, app.opsManifest);
  const { manifest } = parseAppOpsManifest(app.opsManifest);

  const readiness: Record<AppWorkspaceTabKey, AppWorkspaceReadiness> = {
    overview: "ready",
    metrics: hasGa4 || hasConsole ? (hasGa4 && hasConsole ? "ready" : "partial") : "missing",
    operations: toolReadiness(app, "operations"),
    commerce: toolReadiness(app, "commerce"),
    ads:
      toolReadiness(app, "ads") === "ready" || hasGa4 || hasConsole
        ? toolsForSection(app.opsManifest, "ads").length > 0
          ? "ready"
          : "partial"
        : "missing",
    content:
      contentSpec || toolsForSection(app.opsManifest, "content").length > 0
        ? manifest?.analytics?.content && toolsForSection(app.opsManifest, "content").length > 0
          ? "ready"
          : "partial"
        : "missing",
    flags: toolReadiness(app, "flags"),
    fleet: app.repoId ? "ready" : "missing",
    development: "ready",
    releases: "ready",
  };

  return APP_WORKSPACE_TABS.map((tab) => ({
    key: tab.key,
    label: tab.label,
    href: tab.segment ? `${base}/${tab.segment}` : base,
    readiness: readiness[tab.key],
  }));
}
