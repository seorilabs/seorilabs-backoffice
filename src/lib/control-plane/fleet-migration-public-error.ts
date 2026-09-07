/**
 * fleet migration 실행기의 공개 오류 문구를 만든다.
 *
 * 허용한 code 계열만 그대로 내보내고 나머지는 caller가 준 fallback으로 덮는다.
 * 임의 예외 message(스택, 경로, 응답 본문)가 로그로 새어 나가지 않게 하는 경계다.
 *
 * 허용 계열은 모두 **리터럴 상수 code**만 쓰는 것으로 유지한다. 문자열 보간이 섞인
 * message를 이 계열 이름으로 던지면 그 순간 이 경계가 무너진다.
 */
// 접미사는 `CODE:<hex>` 한 형태만 받는다. 실제로 쓰이는 것은 두 곳이고 둘 다 공개 값이다.
//   FLEET_MIGRATION_SHADOW_READINESS_BLOCKED:<sha256 hex>   reason count의 digest
//   FLEET_MIGRATION_KUBERNETES_REQUEST_FAILED:<status>      HTTP status
// 종전 `[A-Z0-9_:,-]+`는 소문자를 받지 않아 digest 접미사가 붙은 readiness 차단 사유가
// 통째로 fallback에 덮였다. 정작 가장 알아야 할 실패가 가려지던 자리다.
const PUBLIC_CODE_PATTERNS = Object.freeze([
  /^FLEET_MIGRATION_[A-Z0-9_,-]+(?::[0-9a-f]{1,64})?$/u,
  /^FLEET_GITHUB_[A-Z0-9_]+$/u,
  /^GITHUB_APP_[A-Z0-9_]+$/u,
  /^REPOSITORY_BACKFILL_[A-Z0-9_]+$/u,
]);

export function fleetMigrationPublicError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return PUBLIC_CODE_PATTERNS.some((pattern) => pattern.test(message)) ? message : fallback;
}
