"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { AppWorkspaceTab } from "@/lib/app-ops/workspace";

const DOT_CLASS = {
  ready: "bg-emerald-500",
  partial: "bg-amber-400",
  missing: "bg-neutral-300",
} as const;

export function AppWorkspaceNav({ tabs }: { tabs: AppWorkspaceTab[] }) {
  const pathname = usePathname();
  return (
    <nav className="-mx-4 mt-5 overflow-x-auto px-4 sm:mx-0 sm:px-0" aria-label="앱 관리 영역">
      <div className="flex min-w-max gap-1 border-b border-neutral-200">
        {tabs.map((tab) => {
          const active =
            tab.key === "overview"
              ? pathname === tab.href
              : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition ${
                active
                  ? "border-neutral-900 text-neutral-900"
                  : "border-transparent text-neutral-500 hover:border-neutral-300 hover:text-neutral-800"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[tab.readiness]}`} />
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
