import type { KeywordApp } from "./keyword-monitoring";
import { dbDay, metricDayOf, metricDayWindow, parseMetricDay } from "@/lib/analytics/metric-day";

export type HistoryParams = Record<string, string | string[] | undefined>;
export interface KeywordSelection { appId: string; country: string; day: string; days: number; terms: string[]; notice: boolean; }
export interface RankObservation { appId: string; target: string; country: string; day: Date; observedAt: Date; value: unknown; sourceUrl: string; }
export interface RankAttempt { appId: string | null; source: string; target: string; status: string; startedAt: Date; completedAt: Date | null; }
export interface RankPoint {
  day: string; rank: number | null; label: string; observationState: "ranked" | "outside" | "invalid" | "missing";
  attemptState: string | null; observedAt: string | null; attemptedAt: string | null; sourceUrl: string;
}
export interface RankHistoryRow extends RankPoint { term: string; previousRank: number | null; previousDay: string | null; change: string; }
export interface RankHistory { dates: string[]; series: { term: string; points: RankPoint[] }[]; rows: RankHistoryRow[]; }
const attemptLabels: Record<string, string> = { observed: "수집됨", empty: "자료 없음", failed: "수집 실패", running: "수집 중", needs_input: "설정·권한 필요", partial: "일부 수집됨", stale: "수집 지연", not_applicable: "대상 아님" };
const single = (value: string | string[] | undefined) => typeof value === "string" ? value : undefined;
export const eligibleKeywordApps = (apps: KeywordApp[]) => apps.filter(app => app.status === "ACTIVE" && app.iosBundle && app.keywords.length && app.countries.length);

export function normalizeKeywordSelection(apps: KeywordApp[], params: HistoryParams, now: Date): KeywordSelection {
  const eligible = eligibleKeywordApps(apps);
  const app = eligible.find(item => item.id === single(params.app)) ?? eligible[0];
  const country = app?.countries.includes(single(params.country) ?? "") ? single(params.country)! : app?.countries[0] ?? "";
  const today = metricDayOf(now), parsedDay = parseMetricDay(single(params.date));
  const day = parsedDay && parsedDay <= today ? parsedDay : today;
  const requestedDays = single(params.days), days = ["7", "30", "90"].includes(requestedDays ?? "") ? Number(requestedDays) : 30;
  const requestedTerms = params.term === undefined ? undefined : Array.isArray(params.term) ? params.term : params.term ? [params.term] : [];
  const terms = requestedTerms === undefined ? app?.keywords.slice(0, 2) ?? [] : [...new Set(requestedTerms)].filter(term => app?.keywords.includes(term)).slice(0, 4);
  const notice = params.notice === "normalized" || [
    params.app !== undefined && params.app !== app?.id,
    params.country !== undefined && params.country !== country,
    params.date !== undefined && params.date !== day,
    params.days !== undefined && params.days !== String(days),
    requestedTerms !== undefined && requestedTerms.join("\0") !== terms.join("\0"),
  ].some(Boolean);
  return { appId: app?.id ?? "", country, day, days, terms, notice };
}

export function keywordHistoryUrl(selection: KeywordSelection): string {
  const query = new URLSearchParams({ app: selection.appId, country: selection.country, date: selection.day, days: String(selection.days) });
  if (selection.terms.length) selection.terms.forEach(term => query.append("term", term));
  else query.set("term", "");
  if (selection.notice) query.set("notice", "normalized");
  return "/feedback/keywords?" + query;
}

export function decodeRank(value: unknown): { state: RankPoint["observationState"]; rank: number | null } {
  const rank = value && typeof value === "object" && !Array.isArray(value) ? (value as { rank?: unknown }).rank : undefined;
  return rank === null ? { state: "outside", rank: null } : typeof rank === "number" && Number.isInteger(rank) && rank >= 1 && rank <= 200 ? { state: "ranked", rank } : { state: "invalid", rank: null };
}
export function rankY(rank: number, top: number, bottom: number) { return top + (rank - 1) / 199 * (bottom - top); }

export function buildKeywordHistory(app: KeywordApp, selection: KeywordSelection, observations: RankObservation[], attempts: RankAttempt[], now: Date, listingTarget = app.iosBundle + ":" + selection.country): RankHistory {
  const dates = metricDayWindow(selection.day, selection.days);
  const own = observations.filter(row => row.appId === app.id && row.country === selection.country && row.day <= new Date(selection.day) && row.observedAt <= now && app.keywords.includes(row.target));
  const observationMap = new Map(own.map(row => [row.target + "\0" + dbDay(row.day), row]));
  const attemptMap = new Map<string, RankAttempt>();
  for (const run of attempts) {
    if (run.appId !== app.id || run.startedAt > now) continue;
    const key = run.source + "\0" + run.target + "\0" + metricDayOf(run.startedAt);
    if (!attemptMap.has(key) || attemptMap.get(key)!.startedAt < run.startedAt) attemptMap.set(key, run);
  }
  const point = (term: string, day: string): RankPoint => {
    const observation = observationMap.get(term + "\0" + day);
    // 국가·검색어는 중앙 validator가 각각 두 글자·100자로 제한하므로 target은 191자 이내다.
    const keyword = attemptMap.get("apple-keyword\0" + selection.country + ":" + term + "\0" + day);
    const listing = attemptMap.get("apple-public-lookup\0" + listingTarget + "\0" + day);
    const attempt = keyword ?? listing;
    const decoded = observation ? decodeRank(observation.value) : { state: "missing" as const, rank: null };
    const attemptState = attempt ? !keyword && attempt.status === "empty" ? "공개 리스팅 미확인" : attemptLabels[attempt.status] ?? "확인 필요" : null;
    const label = decoded.state === "ranked" ? decoded.rank + "위" : decoded.state === "outside" ? "결과 목록에 없음" : decoded.state === "invalid" ? "관측 형식 확인 필요" : attempt && !["observed", "empty"].includes(attempt.status) ? attemptState! : !keyword && listing?.status === "empty" ? "공개 리스팅 미확인" : "미수집";
    const fallbackUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${selection.country}&entity=software&limit=200`;
    let sourceUrl = fallbackUrl;
    if (observation) {
      try {
        const url = new URL(observation.sourceUrl);
        if (url.protocol === "https:" && url.hostname === "itunes.apple.com" && url.pathname === "/search" && !url.username && !url.password) sourceUrl = url.href;
      } catch { /* 이전 관측의 URL이 잘못되어도 순위는 유지한다. */ }
    }
    return { day, rank: decoded.rank, observationState: decoded.state, label, attemptState,
      observedAt: observation?.observedAt.toISOString() ?? null, attemptedAt: attempt?.startedAt.toISOString() ?? null,
      sourceUrl };
  };
  const rows = app.keywords.map((term): RankHistoryRow => {
    const current = point(term, selection.day);
    const previous = own.filter(row => row.target === term && dbDay(row.day) < selection.day && ["ranked", "outside"].includes(decodeRank(row.value).state)).sort((a, b) => b.day.getTime() - a.day.getTime())[0];
    const before = previous ? decodeRank(previous.value).rank : null;
    const change = !["ranked", "outside"].includes(current.observationState) ? "비교 불가" : !previous ? "첫 관측" : before === current.rank ? "변화 없음" : before === null ? "결과 목록 진입" : current.rank === null ? "결과 목록 이탈" : `${Math.abs(before - current.rank)}계단 ${current.rank < before ? "상승" : "하락"}`;
    return { ...current, term, previousRank: before, previousDay: previous ? dbDay(previous.day) : null, change };
  });
  return { dates, rows, series: selection.terms.map(term => ({ term, points: dates.map(day => point(term, day)) })) };
}
