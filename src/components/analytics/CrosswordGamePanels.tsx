import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { isoDate } from "@/lib/ga4/datasets";

// 가로세로 낱말 퍼즐 게임 세부 지표 대시보드 섹션(crossword 전용, 격리 파일).
// CrosswordMetricDaily 스냅샷만 읽는다(BigQuery 직접 조회 없음). 마켓통합/마켓개별을
// 탭으로 전환하고, 완료 퍼널·풀이 성과·힌트/보조·난이도별 지표를 보여준다.

const WINDOW = 28;

// 저장 스키마와 1:1(생성된 Prisma 타입 대신 로컬 타입으로 캐스팅 — page.tsx 관례와 동일).
interface DifficultyMetrics {
  starts: number;
  completes: number;
  abandons: number;
  completionRatePct: number | null;
  avgSolveTimeSec: number | null;
  hintUses: number;
  revealUses: number;
  players: number;
}
interface Breakdowns {
  byDifficulty?: Record<string, DifficultyMetrics>;
}
interface CrosswordRow {
  date: Date;
  market: string;
  starts: number;
  firstInputs: number;
  progressReaches: number;
  completes: number;
  abandons: number;
  completionRatePct: number | null;
  avgSolveTimeSec: number | null;
  noHintCompletes: number;
  firstTryCompletes: number;
  hintUses: number;
  revealUses: number;
  stuckHintUses: number;
  assistAdRequests: number;
  assistAdRewards: number;
  players: number;
  completePlayers: number;
  breakdowns: Breakdowns | null;
}

// 마켓 정의(통합 + 3마켓). 순서는 탭 노출 순서.
const MARKETS: { key: string; label: string }[] = [
  { key: "all", label: "마켓 통합" },
  { key: "apps-in-toss", label: "AppsInToss" },
  { key: "google-play", label: "Google Play" },
  { key: "app-store", label: "App Store" },
];

const DIFFICULTY_ORDER = ["easy", "normal", "hard"];
const DIFFICULTY_LABEL: Record<string, string> = {
  easy: "쉬움",
  normal: "보통",
  hard: "어려움",
};

function pct(v: number | null): string {
  return v == null ? "—" : `${v}%`;
}

function sec(v: number | null): string {
  if (v == null) return "—";
  if (v < 60) return `${Math.round(v)}초`;
  const m = Math.floor(v / 60);
  const s = Math.round(v % 60);
  return `${m}분 ${s}초`;
}

function ratio(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

/**
 * 게임 세부 지표 섹션. crossword-puzzle 앱에서만 렌더된다. market 은 쿼리파라미터로 받은
 * 선택 마켓('all' 기본).
 */
export async function CrosswordGameSection({
  appId,
  appSlug,
  market,
}: {
  appId: string;
  appSlug: string;
  market?: string;
}) {
  const selectedMarket =
    MARKETS.find((m) => m.key === market)?.key ?? "all";

  const rowsDesc = (await prisma.crosswordMetricDaily.findMany({
    where: { appId, market: selectedMarket },
    orderBy: { date: "desc" },
    take: WINDOW,
  })) as unknown as CrosswordRow[];

  // 어떤 마켓이 실제로 수집됐는지(탭 비활성 표시에 사용).
  const presentMarkets = new Set(
    (
      (await prisma.crosswordMetricDaily.findMany({
        where: { appId },
        distinct: ["market"],
        select: { market: true },
      })) as unknown as { market: string }[]
    ).map((r) => r.market),
  );

  return (
    <section className="space-y-6 border-t border-neutral-200 pt-6">
      <div>
        <h2 className="text-lg font-semibold">게임 세부 지표</h2>
        <p className="mt-1 text-sm text-neutral-500">
          완료 퍼널 · 풀이 성과 · 힌트/보조 · 난이도별 · 마켓통합/개별 · 기준일 D-1
        </p>
      </div>

      {/* 마켓 탭 */}
      <div className="flex flex-wrap gap-1.5">
        {MARKETS.map((m) => {
          const active = m.key === selectedMarket;
          const has = m.key === "all" || presentMarkets.has(m.key);
          return (
            <Link
              key={m.key}
              href={`/analytics?app=${appSlug}&market=${m.key}`}
              className={`rounded px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-indigo-600 text-white"
                  : has
                    ? "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                    : "bg-neutral-50 text-neutral-300"
              }`}
            >
              {m.label}
            </Link>
          );
        })}
      </div>

      {rowsDesc.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
          이 마켓의 게임 지표가 아직 없습니다. 앱이 game_* 이벤트를 전송하고 수집이 돌면
          표시됩니다.
        </div>
      ) : (
        <GameBody rowsDesc={rowsDesc} />
      )}
    </section>
  );
}

function GameBody({ rowsDesc }: { rowsDesc: CrosswordRow[] }) {
  const latest = rowsDesc[0];
  const bd = latest.breakdowns?.byDifficulty ?? {};

  return (
    <div className="space-y-6">
      {/* 핵심 카드 */}
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">
          핵심 지표{" "}
          <span className="text-neutral-400">(기준일 {isoDate(latest.date)})</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Card label="시작" value={String(latest.starts)} />
          <Card label="완료" value={String(latest.completes)} />
          <Card label="완료율" value={pct(latest.completionRatePct)} accent />
          <Card label="평균 풀이시간" value={sec(latest.avgSolveTimeSec)} />
          <Card
            label="노힌트 완료율"
            value={pct(ratio(latest.noHintCompletes, latest.completes))}
          />
          <Card
            label="첫도전 완료율"
            value={pct(ratio(latest.firstTryCompletes, latest.completes))}
          />
        </div>
      </div>

      {/* 완료 퍼널 */}
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">완료 퍼널</div>
        <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4">
          <FunnelBar label="시작" value={latest.starts} base={latest.starts} />
          <FunnelBar
            label="첫 입력"
            value={latest.firstInputs}
            base={latest.starts}
          />
          <FunnelBar
            label="진행(마일스톤)"
            value={latest.progressReaches}
            base={latest.starts}
          />
          <FunnelBar label="완료" value={latest.completes} base={latest.starts} />
          <FunnelBar
            label="이탈"
            value={latest.abandons}
            base={latest.starts}
            tone="warn"
          />
        </div>
      </div>

      {/* 힌트/보조 사용 */}
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">
          힌트/보조 사용
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Card label="힌트" value={String(latest.hintUses)} />
          <Card label="정답 보기" value={String(latest.revealUses)} />
          <Card label="막힘 힌트" value={String(latest.stuckHintUses)} />
          <Card label="광고보조 요청" value={String(latest.assistAdRequests)} />
          <Card label="광고보조 보상" value={String(latest.assistAdRewards)} />
        </div>
      </div>

      {/* 난이도별 */}
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">난이도별</div>
        <DifficultyTable byDifficulty={bd} />
      </div>

      {/* 일별 추이 */}
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">
          일별 추이 (최근 {rowsDesc.length}일)
        </div>
        <TrendTable rowsDesc={rowsDesc} />
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        accent
          ? "border-indigo-200 bg-indigo-50"
          : "border-neutral-200 bg-white"
      }`}
    >
      <div className="text-xs text-neutral-500">{label}</div>
      <div
        className={`mt-1 text-lg font-semibold ${
          accent ? "text-indigo-700" : "text-neutral-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function FunnelBar({
  label,
  value,
  base,
  tone = "normal",
}: {
  label: string;
  value: number;
  base: number;
  tone?: "normal" | "warn";
}) {
  const width = base > 0 ? Math.min(100, (value / base) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-24 shrink-0 text-xs text-neutral-500">{label}</div>
      <div className="h-5 flex-1 overflow-hidden rounded bg-neutral-100">
        <div
          className={`h-full ${tone === "warn" ? "bg-amber-400" : "bg-indigo-500"}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="w-28 shrink-0 text-right text-xs tabular-nums text-neutral-600">
        {value.toLocaleString()}{" "}
        <span className="text-neutral-400">({base > 0 ? Math.round(width) : 0}%)</span>
      </div>
    </div>
  );
}

function DifficultyTable({
  byDifficulty,
}: {
  byDifficulty: Record<string, DifficultyMetrics>;
}) {
  const keys = DIFFICULTY_ORDER.filter((k) => byDifficulty[k]);
  if (keys.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
        난이도 데이터 없음
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">난이도</th>
            <th className="px-3 py-2 text-right">시작</th>
            <th className="px-3 py-2 text-right">완료</th>
            <th className="px-3 py-2 text-right">완료율</th>
            <th className="px-3 py-2 text-right">평균 풀이시간</th>
            <th className="px-3 py-2 text-right">힌트</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const d = byDifficulty[k];
            return (
              <tr key={k} className="border-b border-neutral-100 last:border-0">
                <td className="px-3 py-2 font-medium">
                  {DIFFICULTY_LABEL[k] ?? k}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{d.starts}</td>
                <td className="px-3 py-2 text-right tabular-nums">{d.completes}</td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                  {pct(d.completionRatePct)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                  {sec(d.avgSolveTimeSec)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                  {d.hintUses}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TrendTable({ rowsDesc }: { rowsDesc: CrosswordRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">기준일</th>
            <th className="px-3 py-2 text-right">시작</th>
            <th className="px-3 py-2 text-right">완료</th>
            <th className="px-3 py-2 text-right">완료율</th>
            <th className="px-3 py-2 text-right">이탈</th>
            <th className="px-3 py-2 text-right">평균시간</th>
            <th className="px-3 py-2 text-right">플레이어</th>
          </tr>
        </thead>
        <tbody>
          {rowsDesc.map((r) => (
            <tr
              key={isoDate(r.date)}
              className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50"
            >
              <td className="px-3 py-2 text-xs text-neutral-500">
                {isoDate(r.date)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.starts}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.completes}</td>
              <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                {pct(r.completionRatePct)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                {r.abandons}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                {sec(r.avgSolveTimeSec)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                {r.players}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
