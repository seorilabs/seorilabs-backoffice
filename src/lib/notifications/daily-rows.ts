// 앱·일 요약 카드와 그 쓰레드 행이 공유하는 순수 규칙.
//
// 신규 계정과 IAP 결제가 같은 모양(카드 하나 + 쓰레드에 건별 한 줄)을 쓴다. 두 축의
// 표시는 서로 다르지만 아래 두 규칙은 같아야 하고, 특히 행 범위는 틀리면 조용히
// 잘못된 숫자가 나온다. 복제를 허용하지 않는다.

/** 경과 시간을 사람이 읽는 단위로. `45초` / `8분` / `2시간 5분` */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
}

/**
 * 이 이벤트 시점 기준의 순번 범위와 직전 탐색 범위.
 *
 * 상한이 당일 끝이 아니라 이 이벤트 시각이다. Platform 재전송은 옛 이벤트를 다시
 * 들여보내는 유일한 복구 경로인데, 당일 전체를 세면 그 뒤에 생긴 건까지 순번에
 * 들어가 "그 이벤트의 사실" 이 아니게 된다. 순번은 자기를 포함하고(lte),
 * 직전 탐색은 자기를 뺀다(lt).
 */
export function dailyRowRanges(dayStart: Date, occurredAt: Date) {
  return {
    upTo: { gte: dayStart, lte: occurredAt },
    before: { gte: dayStart, lt: occurredAt },
  };
}
