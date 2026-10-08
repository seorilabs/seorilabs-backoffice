import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requirePlatformReadAccess } from "@/lib/platform/access";
import { kstDateTimeShort } from "@/lib/format/kst";
import { env } from "@/lib/env";
export const dynamic = "force-dynamic";
const labels: Record<string, string> = {
  PENDING: "대기",
  RUNNING: "실행 중",
  SUCCEEDED: "완료",
  FAILED: "실패",
  DEAD_LETTER: "재시도 한도 도달",
  CANCELLED: "취소",
};
export default async function Page() {
  await requirePlatformReadAccess();
  const [definitions, runs, permits] = await Promise.all([
    prisma.automationDefinition.findMany({
      include: { app: { select: { id: true, displayName: true, status: true } } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    }),
    prisma.agentRun.findMany({
      where: { OR: [{ app: { status: { not: "DEPRECATED" } } }, { appId: null }] },
      include: {
        occurrence: { include: { definition: true } },
        leases: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
      take: 30,
    }),
    prisma.insightApiRequest.count({
      where: { slot: { not: null }, expiresAt: { gt: new Date() } },
    }),
  ]);
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-8">
      <Link href="/settings" className="text-sm text-blue-700">
        ← 설정
      </Link>
      <h1 className="text-xl font-semibold">자동 실행 관리</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ["등록된 실행 규칙", definitions.length + "개"],
          ["현재 MiniMax 분석 호출", permits + "/2개"],
          ["분석 공급자", env.minimaxChatConfigured() ? "설정됨" : "설정·권한 필요"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-white p-4">
            <p className="text-xs text-neutral-500">{label}</p>
            <p className="mt-1 font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <p className="text-sm text-neutral-600">
        앱별 실행은 앱 설정에서 관리합니다. 인사이트 분석은 자료 조회만 수행하며 이슈 등록·코드
        변경·배포를 자동 실행하지 않습니다. 등록 여부와 실제 작업자 실행 상태는 구분합니다.
      </p>
      <section className="rounded-lg border bg-white p-4">
        <h2 className="mb-3 font-semibold">실행 규칙</h2>
        {definitions.length ? (
          <ul className="divide-y">
            {definitions
              .filter((item) => !item.app || item.app.status !== "DEPRECATED")
              .map((item) => (
                <li className="flex flex-wrap justify-between gap-3 py-3 text-sm" key={item.id}>
                  <div>
                    <p>
                      {item.app?.displayName ?? "조직"} ·{" "}
                      {item.agentKind === "API"
                        ? "운영 인사이트 분석"
                        : (item.agentKind ?? "기존 작업")}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {item.enabled && !item.pausedAt ? "실행 허용" : "일시 중지"} ·{" "}
                      {item.schedule ?? "관측 사건·수동 실행"}
                    </p>
                  </div>
                  {item.appId && (
                    <Link href={`/apps/${item.appId}/settings`} className="text-blue-700">
                      앱 설정에서 관리 →
                    </Link>
                  )}
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">등록된 실행 규칙 없음</p>
        )}
      </section>
      <section className="rounded-lg border bg-white p-4">
        <h2 className="mb-3 font-semibold">최근 실행과 작업자 연결</h2>
        {runs.length ? (
          <ul className="divide-y">
            {runs.map((run) => (
              <li key={run.id} className="py-3 text-sm">
                <p>
                  {run.repoFullName} · {labels[run.status] ?? "확인 필요"} · 시도 {run.attempts}/
                  {run.maxAttempts}
                </p>
                <p className="break-words text-xs text-neutral-500">
                  {kstDateTimeShort(run.updatedAt)} ·{" "}
                  {run.leases.length ? "유효한 작업자 연결 있음" : "유효한 작업자 연결 없음"}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">
            실행 기록 없음 · 앱 설정에서 자동 작업을 등록하거나 관측 자료가 도착하면 표시됩니다.
          </p>
        )}
      </section>
    </div>
  );
}
