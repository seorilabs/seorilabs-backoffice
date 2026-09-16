// 지표 표기 단위의 단일 정본.
//
// 같은 개념이 파일마다 다르게 구현돼 있었다. 퍼센트는 소수 자릿수와 null 처리가
// 셋 다 달랐고, 금액은 세 벌, 건수는 두 벌이었다. 표기가 갈리면 같은 수치가
// 리포트마다 다르게 읽힌다.

/** `₩45,300` */
export function won(value: number): string {
  return `₩${Math.round(value).toLocaleString("ko-KR")}`;
}

/**
 * `12.0%`. null 은 `—`.
 *
 * 기본 소수 1자리다. 잔존율·변화율을 정수로 접으면 반올림이 숨어서 12.4% 와
 * 11.6% 가 같은 값으로 보인다.
 */
export function pct(value: number | null | undefined, digits = 1): string {
  return value == null ? "—" : `${value.toFixed(digits)}%`;
}

/** `1,234명` */
export function count(value: number, unit = ""): string {
  return `${Math.round(value).toLocaleString("ko-KR")}${unit}`;
}

/** null 은 `—`. */
export function countOrDash(value: number | null | undefined, unit = ""): string {
  return value == null ? "—" : count(value, unit);
}
