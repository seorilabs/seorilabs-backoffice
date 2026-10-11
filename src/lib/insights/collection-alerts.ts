export interface CollectionAttempt {
  id: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
}
export interface CollectionEpisode {
  id: string;
  startedAt: Date;
  recovery: CollectionAttempt | null;
}
const healthy = new Set(["observed", "empty"]);
const failed = new Set(["failed", "needs_input", "partial"]);
/** 완료된 실패만 묶는다. 실행 중·미확인은 구간을 열거나 닫지 않는다. */
export function collectionEpisodes(attempts: CollectionAttempt[]): CollectionEpisode[] {
  const episodes: CollectionEpisode[] = [];
  let active: CollectionEpisode | undefined;
  for (const run of [...attempts].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id))) {
    if (!run.completedAt) continue;
    if (failed.has(run.status) && !active) {
      active = { id: run.id, startedAt: run.startedAt, recovery: null };
      episodes.push(active);
    } else if (healthy.has(run.status) && active && run.startedAt > active.startedAt) {
      active.recovery = run;
      active = undefined;
    }
  }
  return episodes;
}
export function shouldWarnCollection(episode: CollectionEpisode, now: Date) {
  return !episode.recovery && now.getTime() - episode.startedAt.getTime() >= 60 * 60_000;
}
export function collectionSourceName(source: string) {
  const names: Record<string, string> = {
    "play-submissions": "Google Play 출시 현황 가져오기",
    "apple-keyword": "App Store 검색 순위 가져오기",
    "apple-public-lookup": "App Store 공개 정보 가져오기",
    "apple-competitor": "App Store 경쟁 앱 정보 가져오기",
    "support-link": "지원·개인정보 링크 확인",
    "official-policy-feed": "스토어 공식 공지 가져오기",
    "reviews:APP_STORE": "App Store 리뷰 가져오기",
    "reviews:GOOGLE_PLAY": "Google Play 리뷰 가져오기",
  };
  return names[source] ?? "외부 운영 자료 가져오기";
}
