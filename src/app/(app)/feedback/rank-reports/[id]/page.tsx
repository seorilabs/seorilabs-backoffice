import { marketLabel } from "@/lib/market/keyword-cycle";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  rankConclusion,
  rankReportSvg,
  rankValue,
  type RankReport,
} from "@/lib/market/rank-report";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^\d{4}-\d{2}-\d{2}-[a-f0-9]{24}$/.test(id)) notFound();
  const event = await prisma.notificationEvent.findUnique({
    where: { dedupeKey: `keyword-report:${id}` },
  });
  const report = (event?.payload as { rankReport?: RankReport } | null)
    ?.rankReport;
  if (!report || report.version !== 1) notFound();
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <Link href={`/feedback?date=${report.day}#daily-search-ranks`}>
        ← 같은 기준일 순위표
      </Link>
      <h1 className="text-2xl font-bold">{report.day} 검색 위치 보고서</h1>
      <p>
        발행 {report.capturedAt.replace("T", " ").slice(0, 19)} UTC · 발행 시점
        자료를 보존한 보고서입니다.
      </p>
      {report.items.map((item, i) => (
        <section
          className="rounded-xl border bg-white p-5 text-slate-900"
          key={i}
        >
          <h2 className="text-xl font-semibold">{rankConclusion(item)}</h2>
          <p className="my-3">
            {item.previousAt ?? item.previousDay ?? "이전 관측 없음"} {item.previousDay ? rankValue(item.previousRank) + " → " : ""} {item.observedAt ?? report.day}{" "}
            {rankValue(item.rank)}
          </p>
          <p>
            {marketLabel(item.market)}, {item.country.toUpperCase()}{item.market === "google-play" ? " 설정 요청" : ""}, 검색어 {item.term}, {item.source ?? "apple-search-api"}, 반환 {item.resultCount ?? "미기록"}개
          </p>
        </section>
      ))}
      <p>
        출처별 반환 목록의 위치입니다. Google Play 국가는 요청 조건입니다. 검색 유입이나 매출의 증가는
        뜻하지 않습니다. 목록 밖과 미수집은 선으로 연결하지 않습니다.
      </p>
      <details open>
        <summary className="cursor-pointer text-lg font-semibold">
          최근 7일
        </summary>
        <div
          className="overflow-auto"
          dangerouslySetInnerHTML={{ __html: rankReportSvg(report) }}
        />
      </details>
      <details>
        <summary className="cursor-pointer text-lg font-semibold">
          최근 28일
        </summary>
        <div
          className="overflow-auto"
          dangerouslySetInnerHTML={{
            __html: rankReportSvg(report, 28, report.items.length),
          }}
        />
      </details>
      <a
        className="inline-block rounded bg-blue-700 px-4 py-2 text-white"
        href={`/feedback/rank-reports/${id}/csv`}
      >
        발행 시점 전체 CSV 다운로드
      </a>
      <div className="overflow-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>앱</th>
              <th>마켓, 출처, 반환 개수</th><th>국가·검색어</th>
              <th>기준일 순위</th>
              <th>이전 관측·순위</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r, i) => (
              <tr className="border-t" key={i}>
                <td className="p-2">{r.appName}</td>
                <td>{marketLabel(r.market)}, {r.source ?? "apple-search-api"}, {r.resultCount ?? "미기록"}개</td><td>
                  <Link
                    href={`/feedback/keywords?app=${encodeURIComponent(r.appId)}&country=${encodeURIComponent(r.country)}&term=${encodeURIComponent(r.term)}&date=${report.day}&days=30&market=${r.market ?? "app-store"}`}
                  >
                    {r.country.toUpperCase()} · {r.term}
                  </Link>
                </td>
                <td>{r.rankLabel}</td>
                <td>
                  {r.previousDay ?? "첫 관측"} ·{" "}
                  {r.previousDay ? rankValue(r.previousRank) : "비교 자료 없음"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
