import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleMetricCards, ConsoleTrendTable, type ConsoleMetricDaily } from "./ConsolePanels";

test("부분 수집 카드는 확인된 값과 미확인 매출을 구별한다", () => {
  const row: ConsoleMetricDaily = { date: new Date("2026-10-11"), dau: 7, newUsers: 0, avgSessionSec: 30, iaaImpressions: null, iaaEarningKrw: null, iapTrxAmountKrw: null, iapSettlementKrw: null, payingUsers: null, raw: null };
  const cards = renderToStaticMarkup(React.createElement(ConsoleMetricCards, { latest: row }));
  assert.match(cards, />7</); assert.match(cards, />0</); assert.match(cards, />30초</);
  assert.equal((cards.match(/>—</g) ?? []).length, 3);
  assert.doesNotMatch(cards, /₩0|>null</);
  const table = renderToStaticMarkup(React.createElement(ConsoleTrendTable, { rowsDesc: [row] }));
  assert.equal((table.match(/>—</g) ?? []).length, 3);
  assert.doesNotMatch(table, /₩0|>null</);
});
