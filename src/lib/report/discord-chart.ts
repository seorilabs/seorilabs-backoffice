import sharp from "sharp";
import { niceMax, splitSegmentsOnNull } from "./chart-geometry";
import type { DiscordAttachment } from "@/lib/notifications/discord";
export interface ReportChartSeries {
  label: string;
  color: string;
  values: Array<number | null>;
}
const escape = (text: string) =>
  text.replace(
    /[<>&"']/g,
    (value) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[value]!,
  );
export function reportChartSvg(input: {
  title: string;
  days: string[];
  series: ReportChartSeries[];
  unit: string;
  source: string;
  reverse?: boolean;
  scope?: string;
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
    input.reverse ? 130 + (value / max) * 275 : 405 - (value / max) * 275;
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
        `<text x="${x(index)}" y="434" text-anchor="middle" font-size="14">${escape(input.days[index])}</text>`,
    )
    .join("");
  const legends = input.series
    .map(
      (series, index) =>
        `<circle cx="${90 + (index % 2) * 405}" cy="${94 + Math.floor(index / 2) * 22}" r="5" fill="${series.color}"/><text x="${103 + (index % 2) * 405}" y="${99 + Math.floor(index / 2) * 22}" font-size="14"><title>${escape(series.label)}</title>${escape(series.label.slice(0, 28))}</text>`,
    )
    .join("");
  const empty = input.series.every((series) => series.values.every((value) => value === null))
    ? '<text x="490" y="270" text-anchor="middle" font-size="22" fill="#64748b">수집된 값 없음</text>'
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="510"><rect width="960" height="510" fill="#ffffff"/><g font-family="Noto Sans CJK KR, sans-serif" fill="#0f172a"><text x="45" y="42" font-size="24" font-weight="700">${escape(input.title)}</text><text x="45" y="68" font-size="14">단위: ${escape(input.unit)} · ${input.reverse ? "낮을수록 상위 노출" : escape(input.scope ?? "범위·표본은 출처 확인")}</text>${legends}${lines.join("")}${empty}${labels}<text x="45" y="470" font-size="13" fill="#475569">${escape(input.source).slice(0, 180)}</text><text x="45" y="493" font-size="13" fill="#475569">빈 구간은 미수집 - 0으로 채우지 않음</text></g></svg>`;
}
export async function reportChartPng(
  input: Parameters<typeof reportChartSvg>[0],
  filename = "metrics-trend.png",
): Promise<DiscordAttachment> {
  const svg = reportChartSvg(input);
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  return { filename, contentType: "image/png", base64: bytes.toString("base64") };
}
