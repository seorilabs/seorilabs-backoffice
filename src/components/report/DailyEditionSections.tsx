import React from "react";
import Link from "next/link";
import type { OrgReportDocument } from "@/lib/core/org-report-schema";
import { coverageSummary, publicationState } from "@/lib/report/daily-contract";
import { Panel } from "./OrgReportSections";
import { actionStatusLabels } from "@/lib/report/action-presentation";
import { SourceCoverageDetails } from "./SourceCoverageDetails";

const time = (value: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

export function DailyEditionSummary({ doc, version }: { doc: OrgReportDocument; version: number | null }) {
  if (!doc.edition) return null;
  const edition = doc.edition, coverage = coverageSummary(edition.sources);
  return <section aria-label="오늘의 결론" className="rounded-xl border border-blue-200 bg-blue-50 p-4 sm:p-5">
    <div className="flex flex-wrap justify-between gap-2 text-xs text-blue-900">
      <span>{publicationState(edition.dueAt, doc.published?.publishedAt, doc.published?.corrections)} · {doc.published ? time(doc.generatedAt) : "11:00 예정"} · v{version ?? "—"}</span>
      <span>입력 고정 {time(edition.frozenAt)} · 한국 시간</span>
    </div>
    <h2 className="mt-3 text-lg font-semibold text-neutral-950">오늘의 결론</h2>
    <ul className="mt-2 space-y-2 text-sm text-neutral-800">{edition.conclusions.map((line) => <li key={line}>{line}</li>)}</ul>
    <div className="mt-4 grid gap-2 text-xs sm:grid-cols-3">
      <div className="rounded-lg bg-white p-3"><b>수집 범위</b><p className="mt-1">{coverage.observed} / {coverage.expected}개 앱·보고서</p></div>
      <div className="rounded-lg bg-white p-3"><b>수치 상태</b><p className="mt-1">{coverage.observed === coverage.expected && coverage.expected > 0 ? "분석 가능" : "잠정 · 확보된 범위만 분석"}</p></div>
      <div className="rounded-lg bg-white p-3"><b>수익 구분</b><p className="mt-1">광고 추정 수익 · 거래액 · 정산 확인을 구분</p></div>
    </div>
    <a className="mt-3 inline-block text-xs text-blue-800 underline" href="#report-source-coverage">누락 원인과 필요한 입력 보기</a>
    {!doc.published?.corrections && new Date(edition.frozenAt).getTime() > new Date(edition.cutoffAt).getTime() + 60_000 && <p className="mt-2 text-xs text-amber-800">예정 컷오프 이후 입력이 고정됐습니다. 실제 고정 시각을 기준으로 읽어 주세요.</p>}
    {edition.replacesVersion && <details className="mt-3 text-xs"><summary className="cursor-pointer">정정 전후 · v{edition.replacesVersion} → v{version}</summary><ul className="mt-2 space-y-1">{edition.changes.map((change) => <li key={change.label}>{change.label}: {change.before} → {change.after}</li>)}</ul><Link className="mt-2 inline-block underline" href={`/?date=${doc.refDate}&version=${edition.replacesVersion}`}>정정 전 발행본 보기</Link></details>}
  </section>;
}

export function DailyEditionActions({ doc }: { doc: OrgReportDocument }) {
  if (!doc.edition) return null;
  return <Panel title="다음 행동">
    {doc.edition.actions.length ? <ul className="space-y-2 text-sm">{doc.edition.actions.map((action, index) => <li key={index}>
      <span className="mr-2 rounded bg-neutral-100 px-2 py-1 text-xs">{actionStatusLabels[action.status]}</span>
      {action.appName} · {action.url ? <Link className="text-blue-700 underline" href={action.url}>{action.title}</Link> : action.title}
    </li>)}</ul> : <p className="text-sm text-neutral-600">등록할 근거를 갖춘 새 개선 후보가 없습니다. 새 이슈 0건도 정상 결과입니다.</p>}
  </Panel>;
}

export function DailyEditionCohorts({ doc }: { doc: OrgReportDocument }) {
  if (!doc.edition) return null;
  const cohorts = doc.edition.cohorts;
  const appIds = [...new Set(cohorts.map((row) => row.appId))];
  return <Panel title="신규 사용자 재방문 · 코호트 잔존">
    <p className="mb-3 text-xs text-neutral-500">첫 실행·첫 방문이 관측된 신규 사용자의 복귀 수 / 코호트 인원. 비율을 평균하지 않습니다. 빈칸은 미성숙·미도착이며 0%가 아닙니다.</p>
    {!cohorts.length && <p className="text-sm text-neutral-600">확인된 코호트 분모와 복귀 수가 없습니다. 수집·계측 상태를 확인하세요.</p>}
    <div className="space-y-2">{appIds.map((appId) => {
      const rows = cohorts.filter((row) => row.appId === appId);
      return <details key={appId} className="rounded border border-neutral-200"><summary className="cursor-pointer px-3 py-2 text-sm">{rows[0].appName} · {rows.length}개 코호트</summary>
        <div className="overflow-x-auto px-3 pb-3"><table className="w-full min-w-[540px] text-right text-xs"><caption className="sr-only">{rows[0].appName} 코호트별 재방문</caption>
          <thead><tr className="border-b"><th className="py-2 text-left">신규 코호트</th><th>인원</th>{[1, 3, 7, 14, 30].map((day) => <th key={day}>D{day}</th>)}</tr></thead>
          <tbody>{rows.map((row) => <tr className="border-b border-neutral-100" key={row.cohortDate}><th className="py-2 text-left font-normal">{row.cohortDate}</th><td>{row.users}{row.users < 50 && <span className="ml-1 text-amber-800">소표본</span>}</td>{row.values.map((cell) => <td key={cell.day} title={cell.returned === null ? "복귀 수 미확인" : `${cell.returned}/${row.users}명`}>{cell.pct === null ? "—" : `${cell.pct.toFixed(1)}%`}<span className="sr-only">{cell.returned === null ? "미확인" : `${cell.returned}/${row.users}명`}</span></td>)}</tr>)}</tbody>
        </table></div>
      </details>;
    })}</div>
  </Panel>;
}

export function DailyEditionSources({ doc }: { doc: OrgReportDocument }) {
  if (!doc.edition) return null;
  const sources = doc.edition.sources;
  const apps = [...new Set(sources.map((source) => source.slug))];
  return <section id="report-source-coverage" aria-label="데이터 상태"><Panel title="데이터 상태 · 앱별 수집 범위">
    <p className="mb-3 text-xs text-neutral-500">발행 입력에 고정된 상태입니다. 빈 응답과 미도착은 0이 아닙니다. 앱을 펼치면 보고서별 기준일·출처·해결 방법을 볼 수 있습니다.</p>
    <div className="space-y-2">{apps.map((slug) => {
      const rows = sources.filter((source) => source.slug === slug), coverage = coverageSummary(rows);
      return <SourceCoverageDetails key={slug} appName={rows[0].appName} observed={coverage.observed} expected={coverage.expected} rows={rows} />;
    })}</div>
  </Panel></section>;
}
