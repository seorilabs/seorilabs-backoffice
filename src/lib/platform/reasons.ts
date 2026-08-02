export const PLATFORM_OPERATION_REASONS = [
  {
    code: "customer_support_compensation",
    label: "고객지원 정책 보상",
  },
  {
    code: "incorrect_grant_correction",
    label: "오지급 정정",
  },
  { code: "incident_recovery", label: "장애 복구" },
  { code: "internal_validation", label: "내부 검증" },
] as const;

export type PlatformOperationReason =
  (typeof PLATFORM_OPERATION_REASONS)[number]["code"];

export const PLATFORM_OPERATION_REASON_CODES = PLATFORM_OPERATION_REASONS.map(
  ({ code }) => code,
) as [PlatformOperationReason, ...PlatformOperationReason[]];
