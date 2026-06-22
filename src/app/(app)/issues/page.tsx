import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { PriorityTag, Pill } from "@/components/badges";
import { asStringArray, fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const fState = one(sp.state) ?? "open";
  const fPriority = one(sp.priority);
  const fRepo = one(sp.repo);
  const fLabel = one(sp.label);

  const where: Prisma.IssueMirrorWhereInput = {
    state: fState === "closed" ? "CLOSED" : fState === "all" ? undefined : "OPEN",
  };
  if (fPriority) where.priority = fPriority as Prisma.EnumPriorityNullableFilter["equals"];
  if (fRepo) where.repoFullName = fRepo;

  let issues = await prisma.issueMirror.findMany({
    where,
    orderBy: [{ priority: "asc" }, { ghUpdatedAt: "desc" }],
    take: 300,
  });
  if (fLabel) {
    issues = issues.filter((i) => asStringArray(i.labels).includes(fLabel));
  }

  const apps = await prisma.app.findMany({
    select: { repoFullName: true, displayName: true },
    orderBy: { displayName: "asc" },
  });

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">크로스레포 이슈</h1>
      <p className="mt-1 mb-4 text-sm text-neutral-500">
        전 레포 이슈 집계 ({issues.length}건 표시)
      </p>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <Select name="priority" label="우선순위" value={fPriority} options={["P1", "P2", "P3", "P4"]} />
        <Select
          name="repo"
          label="레포"
          value={fRepo}
          options={apps.map((a) => a.repoFullName)}
        />
        <Select name="label" label="라벨" value={fLabel} options={["autopilot", "evidence:ga4", "blocked", "approval:planning", "approval:release", "monetization", "retention"]} />
        <Select name="state" label="상태" value={fState} options={["open", "closed", "all"]} />
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white" type="submit">
          필터
        </button>
      </form>

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <tbody>
            {issues.map((i) => (
              <tr key={i.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                <td className="w-12 px-3 py-2">
                  {i.priority ? <PriorityTag priority={i.priority} /> : null}
                </td>
                <td className="px-3 py-2">
                  <a
                    href={`https://github.com/${i.repoFullName}/issues/${i.number}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium hover:underline"
                  >
                    #{i.number} {i.title}
                  </a>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {asStringArray(i.labels)
                      .filter((l) => !l.startsWith("P"))
                      .slice(0, 5)
                      .map((l) => (
                        <Pill key={l}>{l}</Pill>
                      ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-right text-xs text-neutral-500">
                  {i.repoFullName.replace("seorilabs/", "")}
                  <div>{i.state === "CLOSED" ? "closed" : "open"} · {fmtDate(i.ghUpdatedAt)}</div>
                </td>
              </tr>
            ))}
            {issues.length === 0 && (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-neutral-400">
                  조건에 맞는 이슈가 없습니다. (시드/동기화 필요할 수 있음)
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Select({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value?: string;
  options: string[];
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-neutral-500">
      {label}
      <select
        name={name}
        defaultValue={value ?? ""}
        className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-800"
      >
        <option value="">전체</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
