import Link from "next/link";
import { sourceHealth } from "@/lib/insights/queries";
import { kstDateTimeShort } from "@/lib/format/kst";
export const dynamic = "force-dynamic";
export default async function HealthPage() {
  const data = await sourceHealth();
  const names = new Map(data.apps.map((app) => [app.id, app.displayName]));
  return (
    <div className="px-4 py-6 sm:p-8">
      <h1 className="text-xl font-semibold">수집 상태</h1>
      <p className="mt-1 text-sm text-neutral-500">
        지표 기준일 {data.day} · 미수집은 0이 아닙니다. 실패와 자료 없음, 적용 대상 아님을
        구분합니다.
      </p>
      <div className="mt-5 overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="p-3">앱·소스</th>
              <th>상태</th>
              <th>최종 자료</th>
              <th>최근 시도</th>
              <th>확인</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.key} className="border-b border-neutral-100">
                <td className="p-3">
                  {names.get(row.appId ?? "") ?? "조직"}
                  <p className="text-xs text-neutral-500">
                    {row.source} · {row.target}
                  </p>
                </td>
                <td
                  className={
                    /failed|stale|needs_input/.test(row.state)
                      ? "text-rose-700"
                      : "text-neutral-700"
                  }
                >
                  {row.label}
                </td>
                <td>{row.dataThrough ? kstDateTimeShort(row.dataThrough) : "—"}</td>
                <td>{row.attemptedAt ? kstDateTimeShort(row.attemptedAt) : "시도 이력 없음"}</td>
                <td className="pr-3">
                  {row.appId ? (
                    <Link className="text-blue-700" href={`/apps/${row.appId}/settings`}>
                      설정 확인
                    </Link>
                  ) : (
                    "공통 수집기"
                  )}
                  {row.errorCode && <p className="text-xs text-neutral-500">{row.errorCode}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
