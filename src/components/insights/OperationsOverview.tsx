import Link from "next/link";
import { feedbackOverview, pendingWork, sourceHealth } from "@/lib/insights/queries";
import { kstDateTimeShort } from "@/lib/format/kst";

export async function OperationsOverview() {
  const [work, feedback, health] = await Promise.all([
    pendingWork(),
    feedbackOverview(),
    sourceHealth(),
  ]);
  const unhealthy = health.rows.filter((row) =>
    ["failed", "stale", "needs_input", "not_landed"].includes(row.state),
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl border border-neutral-200 bg-white p-4" aria-label="다음 행동">
        <div className="flex justify-between">
          <h2 className="font-semibold">다음 행동</h2>
          <Link className="text-sm text-blue-700" href="/work">
            해야 할 일 →
          </Link>
        </div>
        <div className="my-3 flex flex-wrap gap-2 text-xs">
          <Link href="/work/approvals" className="rounded bg-amber-50 px-2 py-1 text-amber-900">
            배포 승인 {work.approvals}
          </Link>
          <Link href="/settings/health" className="rounded bg-rose-50 px-2 py-1 text-rose-800">
            수집 확인 {unhealthy.length}
          </Link>
          <Link href="/settings" className="rounded bg-neutral-100 px-2 py-1">
            실행 실패 {work.failed}
          </Link>
        </div>
        {work.issues.length === 0 && work.incidents.length === 0 ? (
          <p className="text-sm text-neutral-500">긴급 이슈·장애 없음</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {work.issues.slice(0, 4).map((issue) => (
              <li key={issue.id}>
                <a
                  href={`https://github.com/${issue.repoFullName}/issues/${issue.number}`}
                  className="text-blue-700"
                >
                  P1 · {issue.title}
                </a>
              </li>
            ))}
            {work.incidents.slice(0, 2).map((incident) => (
              <li key={incident.id} className="text-rose-800">
                {incident.summary}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section
        className="rounded-xl border border-neutral-200 bg-white p-4"
        aria-label="새 인사이트"
      >
        <div className="flex justify-between">
          <h2 className="font-semibold">새 인사이트</h2>
          <Link className="text-sm text-blue-700" href="/feedback">
            피드백·시장 →
          </Link>
        </div>
        {feedback.insights.length ? (
          <ul className="mt-3 space-y-3">
            {feedback.insights.slice(0, 4).map((item) => (
              <li key={item.id}>
                <Link href={`/feedback/insights/${item.id}`} className="text-sm text-blue-700">
                  {item.signal.title}
                </Link>
                <p className="text-xs text-neutral-500">
                  {item.status === "PENDING"
                    ? "분석 대기"
                    : item.status === "FALLBACK"
                      ? "사실 요약"
                      : item.status === "READY"
                        ? "분석 완료"
                        : "확인 필요"}{" "}
                  · {kstDateTimeShort(item.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-neutral-500">
            아직 인사이트가 없습니다. 앱 설정에서 외부 모니터링을 지정하면 관측과 분석이 쌓입니다.
          </p>
        )}
      </section>
    </div>
  );
}
