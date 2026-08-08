import type {
  PlatformHealth,
  PlatformOperatorRecord,
  PlatformOrder,
  PlatformUserMetrics,
} from "@/lib/platform/client";

/**
 * 이 파일은 브라우저 번들에 들어간다.
 *
 * 그래서 값(runtime) import를 하지 않는다. client.ts를 값으로 끌어오면
 * google-auth-library가 딸려 들어와 webpack이 fs·child_process를 찾다가
 * 빌드가 깨진다. 조립 로직은 오류 클래스가 필요하므로 서버 전용인
 * snapshot-build.ts에 따로 둔다.
 */

/** 개요 화면이 이름으로 구분해야 하는 조회 구획. */
export type PlatformSnapshotSection =
  | "health"
  | "orders"
  | "operatorRecords"
  | "metrics";

export interface PlatformSectionFailure {
  section: PlatformSnapshotSection;
  label: string;
  error: string;
  code?: string;
}

/**
 * 한 번의 새로고침으로 읽은 플랫폼 상태.
 *
 * 구획별로 실패를 분리한다. 예전에는 네 조회를 Promise.all로 묶어서,
 * 감사 기록 하나가 계약 검증에 걸리면 원장 환경·dead-letter·capability
 * 표시까지 통째로 사라지고 화면에는 "Admin API 연결 실패"라는 틀린
 * 원인이 떴다. 조회 하나가 다른 조회의 진단 가치를 지우면 안 된다.
 */
export interface PlatformIapSnapshot {
  health: PlatformHealth | null;
  orders: PlatformOrder[];
  operatorRecords: PlatformOperatorRecord[];
  /** 구버전 Admin API에는 없는 조회다. null이면 미지원이지 실패가 아니다. */
  metrics: PlatformUserMetrics | null;
  /**
   * 계약 형식을 만족하지 않아 Admin API가 목록에서 제외한 건수.
   *
   * 실패와는 다르다. 조회는 성공했고 나머지 항목은 유효하다. 다만
   * 목록이 불완전하므로 화면이 반드시 알려야 한다. 감사 이력에서
   * 조용한 누락은 잘못된 결론으로 이어진다.
   */
  hiddenOrderCount: number;
  hiddenOperatorRecordCount: number;
  failures: PlatformSectionFailure[];
  checkedAt: string;
}

/** 제외된 항목이 하나라도 있으면 목록이 불완전하다는 뜻이다. */
export function platformSnapshotHasHiddenRecords(
  snapshot: PlatformIapSnapshot,
): boolean {
  return snapshot.hiddenOrderCount > 0 || snapshot.hiddenOperatorRecordCount > 0;
}

export const PLATFORM_SECTION_LABELS: Record<PlatformSnapshotSection, string> = {
  health: "운영 상태",
  orders: "최근 주문",
  operatorRecords: "운영자 변경 이력",
  metrics: "사용자 지표",
};

/**
 * 구획 실패를 한 줄 오류 문구로 요약한다. 실패가 없으면 null이다.
 *
 * 개요 화면은 구획별로 나눠 그리지만 IAP 화면은 단일 오류 배너 하나뿐이다.
 * 그 배너까지 조용해지면 부분 실패가 어디에도 안 보인다.
 */
export function platformSnapshotErrorMessage(
  snapshot: PlatformIapSnapshot,
): string | null {
  const parts = snapshot.failures.map((f) => `${f.label}: ${f.error}`);

  // 제외된 기록도 같은 배너에 싣는다. 실패와 성격이 다르지만 이 화면에는
  // 배너가 하나뿐이고, 조용히 짧아진 목록을 완전한 것으로 읽는 쪽이
  // 성격 구분보다 훨씬 위험하다.
  const hidden: string[] = [];
  if (snapshot.hiddenOperatorRecordCount > 0) {
    hidden.push(`운영자 변경 이력 ${snapshot.hiddenOperatorRecordCount}건`);
  }
  if (snapshot.hiddenOrderCount > 0) {
    hidden.push(`최근 주문 ${snapshot.hiddenOrderCount}건`);
  }
  if (hidden.length > 0) {
    parts.push(
      `${hidden.join(", ")}이 계약 위반으로 목록에서 제외됐습니다. 이 목록은 불완전하므로 없는 것으로 판단하지 마세요.`,
    );
  }

  return parts.length === 0 ? null : parts.join(" / ");
}
