import React from "react";
import Link from "next/link";

import {
  PlatformBadge,
  PlatformEmptyState,
  PlatformMeta,
  PlatformPanel,
  formatPlatformTimestamp,
} from "./PlatformUi";

export type PlatformAuthLookupState =
  | "idle"
  | "loading"
  | "found"
  | "not_found"
  | "error";

export interface PlatformAuthUserView {
  appId: string;
  appLabel?: string;
  platformUserId: string;
  supportCode: string;
  credentialKind?: string | null;
  isAnonymous: boolean;
  blocked?: boolean | null;
  activeRefreshSessions?: number | null;
  createdAt?: string | null;
  lastSeenAt?: string | null;
}

export interface PlatformAuthUserResultProps {
  state: PlatformAuthLookupState;
  user?: PlatformAuthUserView | null;
  message?: string | null;
}

/**
 * 인증 사용자 조회 결과만 표현한다.
 *
 * 토큰, Firebase 원본 UID, 이메일 같은 자격증명·PII 필드는 props 계약에
 * 포함하지 않는다.
 */
export function PlatformAuthUserResult({
  state,
  user,
  message,
}: PlatformAuthUserResultProps) {
  if (state === "idle") {
    return (
      <PlatformPanel title="사용자 조회 결과">
        <PlatformEmptyState title="조회할 사용자를 선택하세요">
          지원 코드 또는 플랫폼 사용자 ID를 지정하면 인증 상태를 표시합니다.
        </PlatformEmptyState>
      </PlatformPanel>
    );
  }

  if (state === "loading") {
    return (
      <PlatformPanel title="사용자 조회 결과">
        <div role="status" className="px-5 py-8 text-center text-sm text-neutral-500">
          인증 상태를 확인하는 중입니다…
        </div>
      </PlatformPanel>
    );
  }

  if (state === "not_found") {
    return (
      <PlatformPanel title="사용자 조회 결과">
        <PlatformEmptyState title="사용자를 찾지 못했습니다">
          {message ?? "지원 코드 또는 플랫폼 사용자 ID를 다시 확인하세요."}
        </PlatformEmptyState>
      </PlatformPanel>
    );
  }

  if (state === "error" || !user) {
    return (
      <PlatformPanel title="사용자 조회 결과">
        <div role="alert" className="border-l-4 border-red-500 bg-red-50 px-4 py-4 text-sm text-red-700">
          {message ?? "인증 사용자 정보를 읽지 못했습니다."}
        </div>
      </PlatformPanel>
    );
  }

  const blockedView =
    user.blocked === true
      ? { label: "차단됨", tone: "red" as const }
      : user.blocked === false
        ? { label: "차단 아님", tone: "green" as const }
        : { label: "차단 상태 미확인", tone: "neutral" as const };

  return (
    <PlatformPanel
      title="사용자 조회 결과"
      description="플랫폼이 반환한 운영용 식별자와 인증 상태만 표시합니다."
      trailing={
        <PlatformBadge tone={blockedView.tone}>{blockedView.label}</PlatformBadge>
      }
    >
      <dl className="grid gap-x-8 px-4 py-2 md:grid-cols-2">
        <PlatformMeta label="앱" value={user.appLabel ?? user.appId} />
        <PlatformMeta label="앱 ID" value={user.appId} mono />
        <PlatformMeta label="플랫폼 사용자 ID" value={user.platformUserId} mono />
        <PlatformMeta label="지원 코드" value={user.supportCode} mono />
        <PlatformMeta
          label="신원 유형"
          value={
            <span className="inline-flex items-center gap-2">
              {user.credentialKind ?? "미확인"}
              <PlatformBadge tone={user.isAnonymous ? "amber" : "blue"}>
                {user.isAnonymous ? "익명" : "검증됨"}
              </PlatformBadge>
            </span>
          }
        />
        <PlatformMeta
          label="활성 refresh 세션"
          value={
            user.activeRefreshSessions == null
              ? "미집계"
              : `${user.activeRefreshSessions.toLocaleString("ko-KR")}개`
          }
        />
        <PlatformMeta label="생성" value={formatPlatformTimestamp(user.createdAt)} />
        <PlatformMeta label="최근 확인" value={formatPlatformTimestamp(user.lastSeenAt)} />
      </dl>
      {message && (
        <div className="border-t border-neutral-100 bg-neutral-50 px-4 py-3 text-xs text-neutral-600">
          {message}
        </div>
      )}
      <div className="border-t border-neutral-100 px-4 py-3 text-right">
        <Link className="text-sm font-medium text-blue-700 hover:underline" href={`/platform/ads?reference=${encodeURIComponent(user.platformUserId)}`}>
          광고 정책 보기
        </Link>
      </div>
    </PlatformPanel>
  );
}
