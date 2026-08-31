"use client";

import { useRouter } from "next/navigation";
import { parseReportDate, shiftDay } from "@/lib/report/params";

// /report 날짜 이동. 상호작용(라우터 push)만 담당하는 소형 클라이언트 컴포넌트 —
// 데이터 로딩·검증은 서버 페이지가 한다. props 는 전부 "YYYY-MM-DD" 문자열이다.

export interface ReportDatePickerProps {
  selected: string;
  min: string;
  max: string;
}

const BASE_PATH = "/report";

export function ReportDatePicker({ selected, min, max }: ReportDatePickerProps) {
  const router = useRouter();
  const go = (date: string) => router.push(`${BASE_PATH}?date=${date}`);

  const buttonCls =
    "rounded border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-700 " +
    "hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-300 disabled:hover:bg-white";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={buttonCls}
        disabled={selected <= min}
        onClick={() => go(shiftDay(selected, -1))}
        aria-label="전일"
      >
        ◀ 전일
      </button>
      <input
        type="date"
        value={selected}
        min={min}
        max={max}
        onChange={(event) => {
          const next = parseReportDate(event.target.value);
          if (next) go(next);
        }}
        className="rounded border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-800"
        aria-label="보고서 기준일"
      />
      <button
        type="button"
        className={buttonCls}
        disabled={selected >= max}
        onClick={() => go(shiftDay(selected, 1))}
        aria-label="익일"
      >
        익일 ▶
      </button>
      <button
        type="button"
        className={buttonCls}
        disabled={selected >= max}
        onClick={() => router.push(BASE_PATH)}
      >
        최신
      </button>
    </div>
  );
}
