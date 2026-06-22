import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { asStringArray, fmtDate, fmtDateTime } from "@/lib/format";
import { hasEvidence } from "@/lib/domain/labels";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import { StageBadge, TypeBadge, PriorityTag, Pill } from "@/components/badges";

export const dynamic = "force-dynamic";

export default async function AppDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const app = await prisma.app.findUnique({
    where: { id },
    include: {
      issues: { orderBy: [{ state: "asc" }, { priority: "asc" }], take: 100 },
      pullRequests: { orderBy: { ghUpdatedAt: "desc" }, take: 50 },
      releases: { orderBy: { updatedAt: "desc" }, take: 30 },
      transitions: { orderBy: { createdAt: "desc" }, take: 30 },
    },
  });
  if (!app) notFound();

  const openIssues = app.issues.filter((i) => i.state === "OPEN");
  const targets = asStringArray(app.marketTargets);

  return (
    <div className="p-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{app.displayName}</h1>
          <div className="mt-1 flex items-center gap-2">
            <TypeBadge type={app.type} engine={app.engine} />
            <StageBadge stage={app.currentStage} />
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
        <Link href="/board" className="text-sm text-neutral-500 hover:underline">
          ← 보드
        </Link>
      </div>

      {/* 메타 */}
      <div className="mt-5 grid grid-cols-2 gap-x-8 gap-y-1.5 rounded-lg border border-neutral-200 bg-white p-4 text-sm md:grid-cols-3">
        <Meta k="마켓" v={targets.join(", ") || "미정"} />
        <Meta k="Play 패키지" v={app.playPackage} needs={targets.includes("play") && !app.playPackage} />
        <Meta k="iOS 번들" v={app.iosBundle} needs={targets.includes("appstore") && !app.iosBundle} />
        <Meta k="Firebase" v={app.firebaseProject} />
        <Meta k="AIT" v={app.aitAppName} needs={targets.includes("ait") && !app.aitAppName} />
        <Meta k="상태" v={app.status} />
      </div>

      {/* 운영(LIVEOPS) 개선 루프 미니보드 */}
      {app.currentStage === "LIVEOPS" && (
        <Section title="지속개선 루프">
          <div className="grid grid-cols-4 gap-3">
            <MiniCol
              title="가설중"
              items={openIssues
                .filter((i) => hasEvidence(asStringArray(i.labels)))
                .map((i) => `#${i.number} ${i.title}`)}
            />
            <MiniCol
              title="구현중(PR)"
              items={app.pullRequests
                .filter((p) => p.state === "OPEN")
                .map((p) => `#${p.number} ${p.title}`)}
            />
            <MiniCol
              title="릴리스대기(merged)"
              items={app.pullRequests
                .filter((p) => p.state === "MERGED")
                .slice(0, 8)
                .map((p) => `#${p.number} ${p.title}`)}
            />
            <MiniCol
              title="재측정대기"
              items={app.releases
                .filter((r) => r.status === "SUCCEEDED")
                .slice(0, 8)
                .map((r) => `${r.market} ${r.version}`)}
            />
          </div>
        </Section>
      )}

      {/* 이슈/PR */}
      <Section title={`이슈 (${openIssues.length} open)`}>
        <div className="divide-y divide-neutral-100">
          {app.issues.slice(0, 40).map((i) => (
            <div key={i.id} className="flex items-center gap-2 py-1.5 text-sm">
              {i.priority && <PriorityTag priority={i.priority} />}
              <a
                href={`https://github.com/${i.repoFullName}/issues/${i.number}`}
                target="_blank"
                rel="noreferrer"
                className={`hover:underline ${i.state === "CLOSED" ? "text-neutral-400 line-through" : ""}`}
              >
                #{i.number} {i.title}
              </a>
              {i.isAutopilot && <Pill tone="blue">autopilot</Pill>}
              {i.hasEvidence && <Pill tone="green">evidence</Pill>}
            </div>
          ))}
          {app.issues.length === 0 && <Empty />}
        </div>
      </Section>

      <Section title="릴리스">
        <div className="divide-y divide-neutral-100">
          {app.releases.map((r) => (
            <div key={r.id} className="flex items-center justify-between py-1.5 text-sm">
              <span>
                <span className="font-medium">{r.version}</span>{" "}
                <span className="text-neutral-500">{r.market}</span>{" "}
                <Pill tone={r.status === "SUCCEEDED" ? "green" : r.status === "FAILED" ? "red" : "amber"}>
                  {r.status}
                </Pill>
              </span>
              <span className="text-xs text-neutral-400">{fmtDate(r.deployedAt)}</span>
            </div>
          ))}
          {app.releases.length === 0 && <Empty />}
        </div>
      </Section>

      <Section title="전이 이력">
        <div className="divide-y divide-neutral-100">
          {app.transitions.map((t) => (
            <div key={t.id} className="flex items-center justify-between py-1.5 text-sm">
              <span>
                {t.fromStage ? STAGE_KO[t.fromStage] : "—"} → {STAGE_KO[t.toStage]}{" "}
                <span className="text-xs text-neutral-400">
                  ({t.source.toLowerCase()}
                  {t.actorLogin ? ` · @${t.actorLogin}` : ""})
                </span>
              </span>
              <span className="text-xs text-neutral-400">{fmtDateTime(t.createdAt)}</span>
            </div>
          ))}
          {app.transitions.length === 0 && <Empty />}
        </div>
      </Section>
    </div>
  );
}

function Meta({ k, v, needs }: { k: string; v?: string | null; needs?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-neutral-500">{k}</span>
      <span className="text-neutral-800">
        {v ?? (needs ? <span className="text-amber-600">확정 필요</span> : "—")}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-semibold text-neutral-700">{title}</h2>
      <div className="rounded-lg border border-neutral-200 bg-white p-4">{children}</div>
    </section>
  );
}

function MiniCol({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded border border-neutral-200 bg-neutral-50 p-2">
      <div className="mb-1 text-xs font-semibold text-neutral-600">
        {title} <span className="text-neutral-400">{items.length}</span>
      </div>
      <div className="space-y-1">
        {items.slice(0, 6).map((t, idx) => (
          <div key={idx} className="truncate rounded bg-white px-1.5 py-1 text-[11px] text-neutral-700">
            {t}
          </div>
        ))}
        {items.length === 0 && <div className="text-[11px] text-neutral-400">—</div>}
      </div>
    </div>
  );
}

function Empty() {
  return <div className="py-4 text-center text-sm text-neutral-400">데이터 없음</div>;
}
