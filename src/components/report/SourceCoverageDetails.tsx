"use client";

import React, { useEffect, useRef, useState } from "react";
import type { SourceCoverage } from "@/lib/report/daily-contract";
import { sourceStateLabel } from "@/lib/insights/collection-state";

export function SourceCoverageDetails({ appName, observed, expected, rows }: {
  appName: string;
  observed: number;
  expected: number;
  rows: readonly SourceCoverage[];
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const [expanded, setExpanded] = useState(false);

  // 초기 스크립트가 도착하기 전에 펼친 경우도 같은 고정 자료로 표시한다.
  useEffect(() => { if (details.current?.open) setExpanded(true); }, []);

  return <details ref={details} onToggle={(event) => setExpanded(event.currentTarget.open)} className="rounded-lg border border-neutral-200 bg-white">
    <summary className="cursor-pointer px-3 py-3 text-sm font-medium">{appName}<span className="ml-2 text-xs font-normal text-neutral-500">{observed}/{expected}개 보고서 확보</span></summary>
    {expanded && <div className="overflow-x-auto px-3 pb-3"><table className="w-full min-w-[640px] text-left text-xs">
      <caption className="sr-only">{appName} 수집 상태</caption>
      <thead><tr className="border-b text-neutral-500"><th className="py-2">소스·보고서</th><th>상태</th><th>자료 기준</th><th>근거·해결 방법</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={`${row.source}:${row.reportType}:${row.account}`} className="border-b border-neutral-100 align-top">
        <td className="max-w-44 py-2 pr-3"><b>{row.source}</b><p>{row.reportType}</p>{row.account && <p className="break-all text-neutral-500">{row.account}</p>}</td>
        <td className="py-2 pr-3">{row.state === "empty" ? "확인된 0" : sourceStateLabel(row.state)}</td>
        <td className="whitespace-nowrap py-2 pr-3">{row.dataThrough ?? "미확인"}</td>
        <td className="max-w-80 py-2"><p>{row.reason}</p>{row.remedy && <p className="mt-1 text-amber-800">{row.remedy}</p>}{row.runId && <p className="mt-1 break-all text-neutral-400">수집 실행 {row.runId}</p>}</td>
      </tr>)}</tbody>
    </table></div>}
  </details>;
}
