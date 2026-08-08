import type { PlatformUserMetrics } from "@/lib/platform/client";

/**
 * 플랫폼 지표 시계열의 순수 계산부.
 *
 * DB와 Admin API 호출은 서버 액션 쪽에 두고, 시각 정규화와 결측 판정만
 * 여기서 다룬다. 이 둘이 이 기능의 실제 계약이고 test로 고정해야 한다.
 */

/** 그래프가 그리는 한 시점. */
export interface PlatformMetricSample {
  capturedAt: string;
  totalUsers: number;
  hourlyActiveUsers: number;
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
}

/**
 * 집계 기준 시각을 정시로 내린다.
 *
 * cron이 10:00:03에 돌든 10:00:47에 돌든 같은 시점으로 모아야
 * capturedAt 유니크가 재실행을 흡수한다. 정시로 내리지 않으면 재시도가
 * 매번 새 행을 만들어 그래프에 같은 시각이 여러 번 찍힌다.
 */
export function floorToHour(at: Date): Date {
  const floored = new Date(at);
  floored.setUTCMinutes(0, 0, 0);
  return floored;
}

/** Admin API 응답을 저장할 행으로 좁힌다. */
export function metricSampleFrom(
  metrics: PlatformUserMetrics,
  capturedAt: Date,
): {
  capturedAt: Date;
  totalUsers: number;
  hourlyActiveUsers: number;
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  activitySource: string;
} {
  return {
    capturedAt: floorToHour(capturedAt),
    totalUsers: metrics.totalUsers,
    hourlyActiveUsers: metrics.hourlyActiveUsers,
    dailyActiveUsers: metrics.dailyActiveUsers,
    weeklyActiveUsers: metrics.weeklyActiveUsers,
    // 정의가 바뀌면 저장된 값에서 드러나야 한다. 숫자만 남기면 나중에
    // 다른 정의로 수집된 구간을 구분할 수 없다.
    activitySource: metrics.activitySource,
  };
}

const HOUR_MS = 60 * 60 * 1000;

/** 그래프가 선을 끊어야 하는 구간. */
export interface PlatformMetricGap {
  /** 결측 직전 샘플의 시각. */
  afterIndex: number;
  missingHours: number;
}

/**
 * 시계열의 결측 구간을 찾는다.
 *
 * cron이 실패하면 구멍이 생기고 백필이 불가능하다. 없는 데이터를 선으로
 * 이어 그리면 "그 시간에도 이 정도였다"는 거짓을 보여주므로, 어디서
 * 끊어야 하는지 그래프에 알려 준다.
 *
 * 1시간 간격이 정상이고, 그보다 벌어지면 결측으로 본다.
 */
export function findMetricGaps(
  samples: readonly PlatformMetricSample[],
): PlatformMetricGap[] {
  const gaps: PlatformMetricGap[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = Date.parse(samples[i - 1].capturedAt);
    const cur = Date.parse(samples[i].capturedAt);
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    const hours = Math.round((cur - prev) / HOUR_MS);
    if (hours > 1) {
      gaps.push({ afterIndex: i - 1, missingHours: hours - 1 });
    }
  }
  return gaps;
}
