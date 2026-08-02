import React from "react";

import type { PlatformTone } from "./presentation";

const BADGE_CLASS: Record<PlatformTone, string> = {
  neutral: "border-neutral-200 bg-neutral-100 text-neutral-600",
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  green: "border-emerald-200 bg-emerald-50 text-emerald-700",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  red: "border-red-200 bg-red-50 text-red-700",
};

export function PlatformBadge({
  tone,
  children,
}: {
  tone: PlatformTone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${BADGE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function PlatformPanel({
  title,
  description,
  trailing,
  children,
}: {
  title: string;
  description?: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-neutral-500">{description}</p>}
        </div>
        {trailing}
      </div>
      {children}
    </section>
  );
}

export function PlatformEmptyState({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-8 text-center">
      <div className="text-sm font-medium text-neutral-700">{title}</div>
      <div className="mx-auto mt-1 max-w-xl text-xs text-neutral-500">{children}</div>
    </div>
  );
}

export function PlatformMeta({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 border-b border-neutral-100 py-2 last:border-0">
      <dt className="shrink-0 text-xs text-neutral-500">{label}</dt>
      <dd
        className={`min-w-0 text-right text-sm text-neutral-800 ${mono ? "break-all font-mono text-xs" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

export function formatPlatformTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
