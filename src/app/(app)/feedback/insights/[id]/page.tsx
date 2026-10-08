import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  evidenceListSchema,
  readInsight,
  renderInsight,
  PERSONAS,
  type Persona,
} from "@/lib/insights/contract";
import { createInsightDraft } from "@/lib/actions/insights";
import { kstDateTimeShort } from "@/lib/format/kst";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await prisma.insightDocument.findUnique({
    where: { id },
    include: { signal: true },
  });
  if (!item) notFound();
  const app = item.signal.appId
    ? await prisma.app.findFirst({
        where: { id: item.signal.appId, status: { not: "DEPRECATED" } },
      })
    : null;
  if (item.signal.appId && !app) notFound();
  const facts = evidenceListSchema.parse(item.signal.facts);
  const content = readInsight(item.content, facts);
  const refs = item.signal.sourceRefs as Array<{ label: string; url: string }>;
  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 md:p-8">
      <Link href="/feedback" className="text-sm text-blue-700">
        ← 피드백·시장
      </Link>
      <h1 className="text-2xl font-semibold">{item.signal.title}</h1>
      <p className="text-sm text-neutral-500">
        {app?.displayName ?? "조직"} · 관측 {kstDateTimeShort(item.signal.observedAt)} ·{" "}
        {item.status === "READY"
          ? "분석 완료"
          : item.status === "FALLBACK"
            ? "사실 요약"
            : "분석 대기·확인 필요"}
      </p>
      <section className="rounded-lg border bg-white p-5">
        <h2 className="mb-3 font-semibold">관측과 다음 행동</h2>
        <ul className="space-y-2 text-sm">
          {renderInsight(content, facts)
            .split("\n")
            .map((line, i) => (
              <li key={i}>{line.replace(/^- /, "")}</li>
            ))}
        </ul>
      </section>
      <section className="rounded-lg border bg-white p-5">
        <h2 className="mb-3 font-semibold">원본 근거</h2>
        <dl className="space-y-3">
          {facts.map((fact) => (
            <div key={fact.id}>
              <dt className="text-sm font-medium">
                {fact.label} · {fact.value}
              </dt>
              <dd className="break-words text-xs text-neutral-500">{fact.source}</dd>
            </div>
          ))}
        </dl>
        <ul className="mt-4 flex flex-wrap gap-4">
          {refs
            .filter((ref) => /^https:\/\//.test(ref.url))
            .map((ref) => (
              <li key={ref.url}>
                <a
                  className="text-sm text-blue-700"
                  href={ref.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {ref.label} ↗
                </a>
              </li>
            ))}
        </ul>
      </section>
      {app && (
        <form action={createInsightDraft} className="rounded-lg border bg-white p-5">
          <input type="hidden" name="id" value={id} />
          <p className="mb-3 text-sm text-neutral-600">
            근거와 가설을 검토하고 앱 개발 화면에서 수정한 뒤 GitHub에 등록하세요.
          </p>
          <button className="rounded bg-blue-700 px-4 py-2 text-sm text-white">
            {item.issueDraftId ? "기존 이슈 초안 열기" : "이슈 초안 만들기"}
          </button>
        </form>
      )}
      <p className="text-xs text-neutral-500">
        분석 역할 {PERSONAS[item.persona as Persona] ?? "서비스 운영 담당"} · 작성 규칙{" "}
        {item.promptVersion} · {item.model ?? "사실 요약"}
        {item.errorCode ? " · " + item.errorCode : ""}
      </p>
    </div>
  );
}
