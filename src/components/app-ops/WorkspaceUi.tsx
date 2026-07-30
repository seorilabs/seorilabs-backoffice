import Link from "next/link";

import type { AppOpsTool } from "@/lib/app-ops/manifest";
import type {
  AppWorkspaceReadiness,
  AppWorkspaceTab,
} from "@/lib/app-ops/workspace";

export function WorkspaceSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-base font-semibold text-neutral-900">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-neutral-500">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function Panel({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      {title && <div className="mb-3 text-sm font-semibold text-neutral-700">{title}</div>}
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-center">
      <div className="text-sm font-semibold text-neutral-700">{title}</div>
      <div className="mx-auto mt-1 max-w-xl text-sm text-neutral-500">{children}</div>
    </div>
  );
}

const READINESS_TEXT: Record<AppWorkspaceReadiness, string> = {
  ready: "연결됨",
  partial: "일부 연결",
  missing: "미설정",
};

const READINESS_CLASS: Record<AppWorkspaceReadiness, string> = {
  ready: "bg-emerald-50 text-emerald-700",
  partial: "bg-amber-50 text-amber-700",
  missing: "bg-neutral-100 text-neutral-500",
};

export function CapabilityGrid({
  tabs,
}: {
  tabs: AppWorkspaceTab[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {tabs
        .filter((tab) => !["overview", "development", "releases"].includes(tab.key))
        .map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            className="rounded-lg border border-neutral-200 bg-white p-4 transition hover:border-neutral-400 hover:shadow-sm"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-neutral-900">{tab.label}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${READINESS_CLASS[tab.readiness]}`}>
                {READINESS_TEXT[tab.readiness]}
              </span>
            </div>
            <div className="mt-2 text-xs text-neutral-400">관리 영역 열기 →</div>
          </Link>
        ))}
    </div>
  );
}

const RISK_TEXT = { low: "낮음", medium: "중간", high: "높음" } as const;
const RISK_CLASS = {
  low: "bg-neutral-100 text-neutral-600",
  medium: "bg-amber-50 text-amber-700",
  high: "bg-red-50 text-red-700",
} as const;

export function ToolCatalog({
  tools,
  repoFullName,
  emptyTitle,
  emptyDescription,
}: {
  tools: AppOpsTool[];
  repoFullName: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (tools.length === 0) {
    return (
      <EmptyState title={emptyTitle}>
        {emptyDescription}
        <div className="mt-2 font-mono text-xs text-neutral-600">
          .seorilabs/backoffice.json
        </div>
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {tools.map((tool) => (
        <div key={tool.id} className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-neutral-900">{tool.title}</h3>
              <p className="mt-1 text-sm text-neutral-500">{tool.description}</p>
            </div>
            <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700">
              manifest
            </span>
          </div>
          {tool.operations.length > 0 ? (
            <div className="mt-4 divide-y divide-neutral-100 rounded border border-neutral-200">
              {tool.operations.map((operation) => (
                <div key={operation.id} className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-neutral-800">{operation.label}</span>
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600">
                      {operation.intent === "read" ? "조회" : "변경"}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${RISK_CLASS[operation.risk]}`}>
                      위험 {RISK_TEXT[operation.risk]}
                    </span>
                    {operation.confirmation !== "none" && (
                      <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700">
                        {operation.confirmation === "typed" ? "문구 재확인" : "사유 필수"}
                      </span>
                    )}
                  </div>
                  {operation.description && (
                    <div className="mt-1 text-xs text-neutral-500">{operation.description}</div>
                  )}
                  {operation.inputs.length > 0 && (
                    <div className="mt-1.5 text-[11px] text-neutral-400">
                      입력: {operation.inputs.map((input) => input.label).join(", ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded border border-dashed border-neutral-200 px-3 py-3 text-xs text-neutral-400">
              선언된 오퍼레이션 없음
            </div>
          )}
          <div className="mt-3 flex items-center justify-between text-xs">
            {tool.runbook ? (
              <a
                href={`https://github.com/${repoFullName}/blob/HEAD/${tool.runbook}`}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline"
              >
                운영 런북 ↗
              </a>
            ) : (
              <span className="text-neutral-400">런북 미등록</span>
            )}
            <span className="text-neutral-400">실행 연결은 후속 단계</span>
          </div>
        </div>
      ))}
    </div>
  );
}
