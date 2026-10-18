export const SOURCE_STATE_LABELS: Record<string, string> = {
  observed: "수집됨",
  empty: "자료 없음",
  not_landed: "아직 도착하지 않음",
  failed: "수집 실패",
  needs_input: "설정·권한 필요",
  needs_instrumentation: "계측 필요",
  not_applicable: "대상 아님",
  running: "수집 중",
  partial: "일부 수집됨",
  stale: "수집 지연",
};
export function sourceStateLabel(state: string) {
  return SOURCE_STATE_LABELS[state] ?? "확인 필요";
}
