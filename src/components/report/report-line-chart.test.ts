import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReportLineChart } from "./ReportLineChart";

const DATES = ["2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31"];

describe("Org 보고서 라인 차트", () => {
  it("값이 있으면 선과 직접 라벨을 그린다", () => {
    const html = renderToStaticMarkup(
      createElement(ReportLineChart, {
        title: "Org DAU",
        dates: DATES,
        series: [{ label: "DAU", varName: "--series-1", values: [40, 55, 50, 60] }],
      }),
    );
    assert.match(html, /<svg/);
    assert.match(html, /<path[^>]*d="M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L/);
    // 직접 라벨: 계열명 + 마지막 값.
    assert.match(html, /DAU 60/);
    // 양 끝 날짜.
    assert.match(html, /2026-08-28/);
    assert.match(html, /2026-08-31/);
    assert.match(html, /표로 보기/);
  });

  it("null(미수집)에서 선을 끊는다", () => {
    const count = (dates: string[], values: (number | null)[]) => {
      const html = renderToStaticMarkup(
        createElement(ReportLineChart, {
          title: "Org DAU",
          dates,
          series: [{ label: "DAU", varName: "--series-1", values }],
        }),
      );
      return (html.match(/<path/g) ?? []).length;
    };
    const five = [...DATES, "2026-09-01"];
    assert.equal(count(DATES, [40, 55, 50, 60]), 1, "연속이면 선 하나");
    assert.equal(count(five, [40, 55, null, 60, 62]), 2, "결측 하나가 선을 둘로 가른다");
  });

  it("고립 점은 마커로 남긴다", () => {
    const html = renderToStaticMarkup(
      createElement(ReportLineChart, {
        title: "수익",
        dates: DATES,
        format: "krw",
        series: [{ label: "광고", varName: "--series-1", values: [null, 500, null, null] }],
      }),
    );
    assert.match(html, /<circle/);
    // krw 포맷 직접 라벨.
    assert.match(html, /광고 ₩500/);
  });

  it("계열이 둘 이상이면 범례를 둔다", () => {
    const html = renderToStaticMarkup(
      createElement(ReportLineChart, {
        title: "수익",
        dates: DATES,
        format: "krw",
        series: [
          { label: "광고", varName: "--series-1", values: [100, 200, 300, 400] },
          { label: "결제", varName: "--series-2", values: [0, 0, 1_000, 0] },
        ],
      }),
    );
    assert.equal((html.match(/광고/g) ?? []).length >= 2, true, "범례 + 직접 라벨");
    assert.match(html, /결제/);
  });

  it("관측값이 전혀 없으면 빈 상태를 안내한다", () => {
    const html = renderToStaticMarkup(
      createElement(ReportLineChart, {
        title: "Org DAU",
        dates: DATES,
        series: [{ label: "DAU", varName: "--series-1", values: [null, null, null, null] }],
      }),
    );
    assert.match(html, /표시할 시계열이 없습니다/);
    assert.doesNotMatch(html, /<svg/);
  });
});
