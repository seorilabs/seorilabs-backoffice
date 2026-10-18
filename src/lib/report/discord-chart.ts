import sharp from "sharp";
import { niceMax, splitSegmentsOnNull } from "./chart-geometry";
import type { DiscordAttachment } from "@/lib/notifications/discord";
export interface ReportChartSeries {
  label: string;
  color: string;
  values: Array<number | null>;
}
/** 발행본에 고정된 확보 범위만 사용한다. 부분 합계를 전체 추이에 채우지 않는다. */
export function ga4ChartContext(doc: {
  refDate: string; summary: { ga4: { apps: number; dau: number } }; apps: unknown[];
  edition?: { sources: Array<{ source: string; state: string; dataThrough: string | null }> };
}) {
  const sources = doc.edition?.sources.filter((row) => row.source === "ga4" && row.state !== "not_applicable") ?? [];
  const observed = doc.summary.ga4.apps, expected = Math.max(observed, sources.length || doc.apps.length);
  const hasPartial = observed > 0 || sources.some((row) => row.dataThrough !== null);
  return {
    scope: `기준 ${doc.refDate} · 자료 확보 ${observed}/${expected}개 앱${observed ? ` · 확보분 활성 ${doc.summary.ga4.dau.toLocaleString("ko-KR")}명` : ""}`,
    emptyLabel: hasPartial ? "전체 합계 미확정 · 앱별 확보 자료는 본문에서 확인" : "수집된 값 없음",
  };
}
const escape = (text: string) =>
  text.replace(
    /[<>&"']/g,
    (value) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[value]!,
  );
// 한글과 영문이 섞인 범례도 보수적인 글자 폭으로 줄바꿈한다. 생략하면
// 다운로드 종류처럼 서로 다른 계열을 PNG에서 구분할 수 없어진다.
function legendLines(label: string): string[] {
  const lines: string[] = [];
  let line = "", width = 0;
  for (const token of label.split(/(\s+)/)) {
    const tokenWidth = [...token].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
    if (line && width + tokenWidth > 48) { lines.push(line); line = ""; width = 0; }
    for (const char of token) {
      const charWidth = char.charCodeAt(0) > 255 ? 2 : 1;
      if (width + charWidth > 48) { lines.push(line); line = ""; width = 0; }
      line += char; width += charWidth;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}
export function reportChartSvg(input: {
  title: string;
  days: string[];
  series: ReportChartSeries[];
  unit: string;
  source: string;
  reverse?: boolean;
  scope?: string;
  emptyLabel?: string;
}): string {
  if (
    !input.days.length ||
    input.days.length > 60 ||
    input.series.length > 4 ||
    input.series.some(
      (series) =>
        series.values.length !== input.days.length ||
        !/^#[a-f0-9]{6}$/i.test(series.color) ||
        series.values.some((value) => value !== null && (!Number.isFinite(value) || value < 0)),
    )
  )
    throw new Error("INVALID_CHART_DATA");
  const legendRows = input.series.map((series) => legendLines(series.label));
  const rowHeights = [0, 2].filter((offset) => offset < legendRows.length)
    .map((offset) => Math.max(...legendRows.slice(offset, offset + 2).map((row) => row.length)) * 18 + 6);
  const extraHeight = Math.max(0, rowHeights.reduce((sum, height) => sum + height, 0) - 36);
  const height = 510 + extraHeight;
  const max = niceMax(
    Math.max(
      0,
      ...input.series.flatMap((series) =>
        series.values.filter((value): value is number => value != null),
      ),
    ),
  );
  const x = (index: number) => 85 + (index * 810) / Math.max(1, input.days.length - 1);
  const y = (value: number) =>
    extraHeight + (input.reverse ? 130 + (value / max) * 275 : 405 - (value / max) * 275);
  const lines: string[] = [];
  for (let tick = 0; tick <= 4; tick++) {
    const value = (max * tick) / 4;
    const pos = y(value);
    lines.push(
      `<line x1="85" y1="${pos}" x2="895" y2="${pos}" stroke="#e2e8f0"/><text x="72" y="${pos + 5}" text-anchor="end" font-size="14">${value.toLocaleString("en-US")}</text>`,
    );
  }
  for (const series of input.series) {
    const segments = splitSegmentsOnNull(series.values, x, y);
    lines.push(
      ...segments.paths.map(
        (path) => `<path d="${path}" fill="none" stroke="${series.color}" stroke-width="3"/>`,
      ),
      ...segments.lonePoints.map(
        (point) => `<circle cx="${point.x}" cy="${point.y}" r="4" fill="${series.color}"/>`,
      ),
    );
  }
  const labels = [0, Math.floor((input.days.length - 1) / 2), input.days.length - 1]
    .filter((value, index, array) => array.indexOf(value) === index)
    .map(
      (index) =>
        `<text x="${x(index)}" y="${434 + extraHeight}" text-anchor="middle" font-size="14">${escape(input.days[index])}</text>`,
    )
    .join("");
  const legends = input.series
    .map(
      (series, index) => {
        const top = 99 + (index < 2 ? 0 : rowHeights[0]);
        const left = 103 + (index % 2) * 405;
        return `<circle cx="${left - 13}" cy="${top - 5}" r="5" fill="${series.color}"/><text font-size="14"><title>${escape(series.label)}</title>${legendRows[index].map((line, row) => `<tspan x="${left}" y="${top + row * 18}">${escape(line)}</tspan>`).join("")}</text>`;
      },
    )
    .join("");
  const empty = input.series.every((series) => series.values.every((value) => value === null))
    ? `<text x="490" y="${270 + extraHeight}" text-anchor="middle" font-size="22" fill="#64748b">${escape(input.emptyLabel ?? "수집된 값 없음")}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}"><rect width="960" height="${height}" fill="#ffffff"/><g font-family="Noto Sans CJK KR, sans-serif" fill="#0f172a"><text x="45" y="42" font-size="24" font-weight="700">${escape(input.title)}</text><text x="45" y="68" font-size="14">단위: ${escape(input.unit)} · ${input.reverse ? "낮을수록 상위 노출" : escape(input.scope ?? "범위·표본은 출처 확인")}</text>${legends}${lines.join("")}${empty}${labels}<text x="45" y="${470 + extraHeight}" font-size="13" fill="#475569">${escape(input.source).slice(0, 180)}</text><text x="45" y="${493 + extraHeight}" font-size="13" fill="#475569">빈 구간은 미수집·일부 수집·해당 없음 - 0으로 채우지 않음</text></g></svg>`;
}
export async function reportChartPng(
  input: Parameters<typeof reportChartSvg>[0],
  filename = "metrics-trend.png",
): Promise<DiscordAttachment> {
  const svg = reportChartSvg(input);
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  return { filename, contentType: "image/png", base64: bytes.toString("base64") };
}
