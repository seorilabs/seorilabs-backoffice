/**
 * 알림 표시 토큰의 단일 정본.
 *
 * 색과 상태 기호가 빌더마다 흩어져 있으면 같은 의미가 채널마다 다르게 읽힌다.
 */

/**
 * embed 왼쪽 색 막대.
 *
 * 라이트(#FFFFFF)와 다크(#313338) 양쪽에서 읽히도록 상대 휘도를 0.20~0.42 구간에
 * 모았다. 이보다 어두우면 다크에서 배경에 묻히고, 밝으면 라이트에서 날아간다.
 * 순수 #FF0000 계열은 다크에서 진동해 쓰지 않는다.
 */
export const EMBED_COLOR = {
  /** 성공·복구·승인 완료 */
  SUCCESS: 0x2FA55C,
  /** 실패·장애 발생 */
  FAILURE: 0xD83C3E,
  /** 경고·확인됨·임계 근접 */
  WARNING: 0xE8A33D,
  /** 진행 중·요청됨·트리거됨 */
  PROGRESS: 0x4F8BF0,
  /** 정기 리포트 */
  INFO: 0x5865F2,
  /** 판정 없는 집계 */
  NEUTRAL: 0x737C8C,
} as const;

export type EmbedColor = (typeof EMBED_COLOR)[keyof typeof EMBED_COLOR];
