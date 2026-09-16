import { metricDayOf } from "@/lib/analytics/metric-day";

// KST 시각 표기의 단일 정본.
//
// 왜 한 곳인가. 같은 채널에 "2026. 9. 16. 오후 5:46:36" 과
// "2026-09-16T08:46:36.000Z" 가 섞여 나가고 있었다. 빌더마다 Intl 옵션을 손으로
// 적거나 toISOString() 을 그대로 흘린 결과다. 표기를 고르는 판단은 여기 한 번만 둔다.
//
// 날짜 축(달력일)은 여기서 다루지 않는다. 그건 metric-day.ts 의 metricDayOf 가
// 정본이고, 이 모듈도 같은 날인지 비교할 때 그것을 쓴다.

const TZ = "Asia/Seoul";

const DATE_TIME = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TZ,
  dateStyle: "medium",
  timeStyle: "medium",
});

const CLOCK = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const HOUR_MINUTE = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DATE_TIME_SHORT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const DATE_SHORT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TZ,
  month: "2-digit",
  day: "2-digit",
});

/** 리포트·카드 본문의 절대 시각. `2026. 9. 16. 오후 2:53:35` */
export function kstDateTime(at: Date): string {
  return DATE_TIME.format(at);
}

/** 초까지 필요한 기록용 시계. `14:53:35` */
export function kstClock(at: Date): string {
  return CLOCK.format(at);
}

/**
 * 로그 한 줄에 붙이는 시각. 같은 KST 날이면 `14:53`, 다른 날이면 `09-15 00:05`.
 *
 * 발생일과 게시일이 다른 알림이 실제로 있다(Platform 재전송 복구, 늦게 도착한
 * 이벤트). 날이 다를 때만 날짜를 붙여, 줄 안에서 "언제 일인지" 를 판정할 수 있게 한다.
 */
export function kstLogStamp(at: Date, now: Date = new Date()): string {
  const day = metricDayOf(at);
  if (day === metricDayOf(now)) return HOUR_MINUTE.format(at);
  return `${day.slice(5)} ${HOUR_MINUTE.format(at)}`;
}

/** 화면 표 셀. `2026. 09. 16. 14:53` */
export function kstDateTimeShort(d: Date | null | undefined): string {
  return d ? DATE_TIME_SHORT.format(d) : "—";
}

/** 화면 표 셀. `09. 16.` */
export function kstDateShort(d: Date | null | undefined): string {
  return d ? DATE_SHORT.format(d) : "—";
}
