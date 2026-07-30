import Link from "next/link";

import { StageBadge, StatusBadge, TypeBadge } from "@/components/badges";
import { AppWorkspaceNav } from "@/components/app-ops/AppWorkspaceNav";
import type { AppWorkspaceTab } from "@/lib/app-ops/workspace";

interface AppHeader {
  displayName: string;
  repoFullName: string;
  type: "APP" | "GAME";
  engine: "RN" | "GODOT";
  currentStage: "PLANNING" | "DEVELOPMENT" | "QA" | "MARKET_SUBMISSION" | "RELEASE" | "LIVEOPS";
  status: "ACTIVE" | "PAUSED" | "DEPRECATED";
  opsManifestError: string | null;
}

export function AppWorkspaceShell({
  app,
  tabs,
  children,
}: {
  app: AppHeader;
  tabs: AppWorkspaceTab[];
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-6 sm:p-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-1 text-xs text-neutral-400">
            <Link href="/" className="hover:text-neutral-700 hover:underline">
              앱
            </Link>
            <span className="mx-1.5">/</span>
            관리 워크스페이스
          </div>
          <h1 className="text-xl font-semibold">{app.displayName}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <TypeBadge type={app.type} engine={app.engine} />
            <StageBadge stage={app.currentStage} />
            <StatusBadge status={app.status} always />
            <a
              href={`https://github.com/${app.repoFullName}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-blue-600 hover:underline"
            >
              {app.repoFullName}
            </a>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 연결
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> 일부
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-neutral-300" /> 미설정
          </span>
        </div>
      </div>

      <AppWorkspaceNav tabs={tabs} />

      {app.opsManifestError && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <b>관리툴 manifest 오류</b>
          <div className="mt-0.5 font-mono text-xs">{app.opsManifestError}</div>
        </div>
      )}

      <main className="mt-6">{children}</main>
    </div>
  );
}
