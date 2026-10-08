import { resolveAitTarget } from "@/lib/analytics/ait-apps";
import { resolveGa4Target } from "@/lib/ga4/datasets";
import {
  toolsForSection,
  type AppOpsSection,
} from "@/lib/app-ops/manifest";

export const APP_WORKSPACE_TABS = [
  { key: "overview", segment: "", label: "개요" },
  { key: "metrics", segment: "metrics", label: "지표" },
  { key: "operations", segment: "operations", label: "운영" },
  { key: "feedback", segment: "feedback", label: "피드백" },
  { key: "development", segment: "development", label: "개발" },
  { key: "releases", segment: "releases", label: "출시" },
  { key: "settings", segment: "settings", label: "설정" },
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

  const readiness: Record<AppWorkspaceTabKey, AppWorkspaceReadiness> = {
    overview: "ready",
    metrics: hasGa4 || hasConsole ? "ready" : "missing",
    operations: toolReadiness(app, "operations"),
    feedback: "ready",
    settings: app.repoId ? "ready" : "missing",
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
