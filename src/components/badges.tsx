import type { Lifecycle, AppStatus } from "@prisma/client";
import { STAGE_KO, STATUS_KO } from "@/lib/domain/lifecycle";
import type { MarketStatus } from "@/lib/queries";

const STATUS_COLOR: Record<AppStatus, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-700",
  PAUSED: "bg-amber-100 text-amber-800",
  DEPRECATED: "bg-neutral-200 text-neutral-600",
};

// 운영(ACTIVE)은 기본값이라 표시 생략 — 존치/일시중지만 뱃지로 부각.
export function StatusBadge({
  status,
  always = false,
}: {
  status: AppStatus;
  always?: boolean;
}) {
  if (status === "ACTIVE" && !always) return null;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_COLOR[status]}`}
    >
      {STATUS_KO[status]}
    </span>
  );
}

const STAGE_COLOR: Record<Lifecycle, string> = {
  PLANNING: "bg-slate-100 text-slate-700",
  DEVELOPMENT: "bg-blue-100 text-blue-700",
  QA: "bg-violet-100 text-violet-700",
  MARKET_SUBMISSION: "bg-amber-100 text-amber-800",
  RELEASE: "bg-emerald-100 text-emerald-700",
  LIVEOPS: "bg-teal-100 text-teal-700",
};

export function StageBadge({ stage }: { stage: Lifecycle }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${STAGE_COLOR[stage]}`}
    >
      {STAGE_KO[stage]}
    </span>
  );
}

export function TypeBadge({ type, engine }: { type: string; engine: string }) {
  const isGame = type === "GAME";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${
        isGame ? "bg-pink-100 text-pink-700" : "bg-indigo-100 text-indigo-700"
      }`}
    >
      {isGame ? "게임" : "앱"} · {engine}
    </span>
  );
}

const MARKET_DOT: Record<MarketStatus, string> = {
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  pending: "bg-amber-400",
  none: "bg-neutral-300",
};

const MARKET_LABEL: Record<string, string> = {
  play: "Play",
  appstore: "iOS",
  ait: "AIT",
  web: "Web",
};

export function MarketDots({
  targets,
  status,
}: {
  targets: string[];
  status: Record<string, MarketStatus>;
}) {
  if (targets.length === 0)
    return <span className="text-xs text-neutral-400">마켓 미정</span>;
  return (
    <div className="flex items-center gap-1.5">
      {targets.map((m) => (
        <span key={m} className="inline-flex items-center gap-1 text-xs text-neutral-600">
          <span
            className={`inline-block h-2 w-2 rounded-full ${MARKET_DOT[status[m] ?? "none"]}`}
          />
          {MARKET_LABEL[m] ?? m}
        </span>
      ))}
    </div>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "red" | "amber" | "green" | "blue";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-neutral-100 text-neutral-600",
    red: "bg-red-100 text-red-700",
    amber: "bg-amber-100 text-amber-800",
    green: "bg-emerald-100 text-emerald-700",
    blue: "bg-blue-100 text-blue-700",
  };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function PriorityTag({ priority }: { priority: string }) {
  const tone =
    priority === "P1"
      ? "bg-red-600 text-white"
      : priority === "P2"
        ? "bg-orange-500 text-white"
        : priority === "P3"
          ? "bg-yellow-400 text-yellow-900"
          : "bg-neutral-200 text-neutral-700";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${tone}`}>
      {priority}
    </span>
  );
}
