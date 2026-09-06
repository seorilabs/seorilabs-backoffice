/**
 * 업데이트 유도 정책의 표현과 확인 문구.
 *
 * **권장이 기본 모드이고 강제는 예외다.** `recommendOverride`가 비어 있으면
 * 서버가 관측된 최신 안정 버전을 자동 추종한다. `blockedVersions`에 적힌
 * 버전만 강제되며, 임계값("X 미만 차단") 방식은 지원하지 않는다.
 */

/**
 * 정책을 걸 수 있는 플랫폼.
 *
 * ait와 web은 없다. 미니앱 번들은 토스가 전달하고 웹은 새로고침이라
 * 유저가 "설치본을 업데이트"할 대상 자체가 없다.
 */
export const UPDATE_POLICY_PLATFORMS = ["android", "ios"] as const;

export type UpdatePolicyPlatform = (typeof UPDATE_POLICY_PLATFORMS)[number];

/** 한 플랫폼에서 강제할 수 있는 버전 수. 서버와 같은 값이다. */
export const MAX_BLOCKED_VERSIONS = 20;

export interface UpdatePolicyPlatformView {
  blockedVersions: Array<{ version: string; blockedAt?: string }>;
  recommendOverride?: string;
  /** override가 없을 때 실제로 적용되는 값. */
  autoRecommendedVersion?: string;
  /** 이 플랫폼의 유저가 실제로 열게 될 주소. */
  updateUrl?: string;
}

export interface ObservedAppVersionView {
  platform: string;
  version: string;
  runtime?: string;
  firstSeenAt: string;
}

export interface UpdatePolicyView {
  appId: string;
  platforms: Record<string, UpdatePolicyPlatformView>;
  observedVersions: ObservedAppVersionView[];
}

/**
 * 정책 변경 사유.
 *
 * 기존 `PLATFORM_OPERATION_REASONS`는 IAP·광고 원장 조작용("고객지원 정책
 * 보상", "오지급 정정")이라 여기에 맞지 않는다. 환불 검토가 이미 별도 enum을
 * 두는 선례가 있다.
 */
export const PLATFORM_UPDATE_POLICY_REASONS = [
  { code: "new_release_rollout", label: "새 릴리스 확산" },
  { code: "broken_build", label: "치명적 결함 빌드 차단" },
  { code: "security_fix", label: "보안 수정 배포" },
  { code: "incident_recovery", label: "장애 복구" },
  { code: "internal_validation", label: "내부 검증" },
] as const;

export type PlatformUpdatePolicyReason =
  (typeof PLATFORM_UPDATE_POLICY_REASONS)[number]["code"];

export const PLATFORM_UPDATE_POLICY_REASON_CODES =
  PLATFORM_UPDATE_POLICY_REASONS.map(({ code }) => code) as [
    PlatformUpdatePolicyReason,
    ...PlatformUpdatePolicyReason[],
  ];

export interface UpdatePolicyPlatformInput {
  platform: UpdatePolicyPlatform;
  blockedVersions: string[];
  recommendOverride: string;
}

/** 쉼표 문자열과 배열을 오간다. 큐 파라미터는 flat scalar만 담을 수 있다. */
export function joinVersions(versions: readonly string[]): string {
  return versions.join(",");
}

export function splitVersions(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * 이번 요청으로 **새로 막히는** 버전.
 *
 * 이미 막혀 있던 버전을 그대로 두는 요청과 새로 막는 요청을 구분한다.
 * 해제에는 확인 문구가 없다 — 되돌리기는 언제나 즉시 가능해야 한다.
 */
export function addedBlockedVersions(
  current: Record<string, UpdatePolicyPlatformView>,
  next: readonly UpdatePolicyPlatformInput[],
): Record<UpdatePolicyPlatform, string[]> {
  const added = { android: [] as string[], ios: [] as string[] };
  for (const entry of next) {
    const existing = current[entry.platform]?.blockedVersions ?? [];
    for (const version of entry.blockedVersions) {
      const already = existing.some((item) => sameVersion(item.version, version));
      if (!already) added[entry.platform].push(version);
    }
    added[entry.platform].sort();
  }
  return added;
}

/**
 * 서버가 대조하는 확인 문구.
 *
 * 서버 구현과 같은 규칙이어야 한다. 어긋나면 운영자가 이유를 알 수 없는
 * 거절을 받는다. 서버는 기대 문구를 오류 메시지에 담아 돌려주므로
 * 화면이 그대로 보여준다.
 */
export function platformUpdatePolicyConfirmationText(
  appSlug: string,
  added: Record<UpdatePolicyPlatform, string[]>,
): string {
  const parts: string[] = [];
  for (const platform of UPDATE_POLICY_PLATFORMS) {
    for (const version of added[platform]) {
      parts.push(`BLOCK ${appSlug} ${platform} ${version}`);
    }
  }
  return parts.join("; ");
}

/**
 * 서버 `parseVersion`과 같은 규칙으로 읽는다.
 *
 * `@/lib/core/stable-semver`는 정확히 `X.Y.Z`만 받아 `1.4`를 거부한다.
 * 서버는 자리 수가 모자라도 0으로 채우므로, 그걸 그대로 쓰면 같은 빌드를
 * 다르다고 판정한다.
 */
function parseVersion(raw: string): [number, number, number] | null {
  const value = raw.trim().replace(/^v/i, "");
  if (value === "") return null;
  const parts = value.split(".");
  if (parts.length > 3) return null;
  const out: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (!/^\d+$/.test(part)) return null;
    out[index] = Number(part);
  }
  return out;
}

/** 원문이 아니라 파싱 결과로 비교한다. `1.4` `1.4.0` `v1.4.0`은 같은 빌드다. */
export function sameVersion(left: string, right: string): boolean {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left.trim() === right.trim();
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** 최신 빌드를 먼저 보여준다. 해석 불가한 값은 뒤로 보낸다. */
export function compareVersionsDesc(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a && b) {
    for (let index = 0; index < 3; index += 1) {
      const difference = b[index] - a[index];
      if (difference !== 0) return difference;
    }
    return 0;
  }
  if (a) return -1;
  if (b) return 1;
  return right.localeCompare(left, "en");
}
