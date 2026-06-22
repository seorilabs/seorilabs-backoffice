import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { asStringArray, fmtDate } from "@/lib/format";
import { TypeBadge } from "@/components/badges";

export const dynamic = "force-dynamic";

const MARKETS: { key: string; label: string }[] = [
  { key: "PLAY", label: "Google Play" },
  { key: "APPSTORE", label: "App Store" },
  { key: "AIT", label: "AppsInToss" },
];

const STATUS_DOT: Record<string, string> = {
  SUCCEEDED: "bg-emerald-500",
  FAILED: "bg-red-500",
  IN_PROGRESS: "bg-amber-400",
  PENDING: "bg-amber-300",
  ROLLED_BACK: "bg-neutral-500",
};

export default async function ReleasesPage() {
  const apps = await prisma.app.findMany({
    orderBy: [{ type: "asc" }, { displayName: "asc" }],
    include: { releases: { orderBy: { updatedAt: "desc" } } },
  });

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">마켓별 출시 매트릭스</h1>
      <p className="mt-1 mb-4 text-sm text-neutral-500">
        앱 × 마켓 배포 상태 (tag push + deploy workflow_run 기반)
      </p>

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
              <th className="px-3 py-2">앱</th>
              {MARKETS.map((m) => (
                <th key={m.key} className="px-3 py-2">
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => {
              const targets = asStringArray(a.marketTargets);
              return (
                <tr key={a.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                  <td className="px-3 py-2">
                    <Link href={`/apps/${a.id}`} className="font-medium hover:underline">
                      {a.displayName}
                    </Link>
                    <div className="mt-0.5">
                      <TypeBadge type={a.type} engine={a.engine} />
                    </div>
                  </td>
                  {MARKETS.map((m) => {
                    const targeted = targets.includes(m.key.toLowerCase());
                    const rel = a.releases.find((r) => r.market === m.key);
                    if (!targeted) {
                      return (
                        <td key={m.key} className="px-3 py-2 text-xs text-neutral-300">
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={m.key} className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`inline-block h-2 w-2 rounded-full ${
                              rel ? STATUS_DOT[rel.status] ?? "bg-neutral-300" : "bg-neutral-300"
                            }`}
                          />
                          <span className="text-xs text-neutral-700">
                            {rel ? `${rel.version}` : "대기"}
                          </span>
                        </div>
                        {rel?.deployedAt && (
                          <div className="text-[11px] text-neutral-400">{fmtDate(rel.deployedAt)}</div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
