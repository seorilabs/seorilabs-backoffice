import React from "react";

import type { PlatformUserAds } from "@/lib/platform/client";
import type { AdsLookupState } from "@/lib/platform/ads-presentation";

import { PlatformBadge } from "./PlatformUi";

export function PlatformAdsLookupFeedback({
  state,
  error,
}: {
  state: AdsLookupState;
  error?: string;
}) {
  if (state === "loading") {
    return (
      <p role="status" className="px-4 pb-4 text-sm text-neutral-500">
        조회 중
      </p>
    );
  }
  if (state === "not_found") {
    return (
      <div role="alert" className="px-4 pb-4 text-sm text-amber-700">
        일치하는 사용자를 찾지 못했습니다.
      </div>
    );
  }
  if (state === "read_failure") {
    return (
      <div role="alert" className="px-4 pb-4 text-sm text-red-600">
        확인 실패{error ? ` — ${error}` : ""}
      </div>
    );
  }
  return null;
}

export function PlatformAdsPolicyBadge({
  policy,
}: {
  policy: PlatformUserAds["policy"];
}) {
  const label = !policy.appUsesAds
    ? "광고 기능을 사용하지 않는 앱"
    : policy.adsEnabled
      ? "광고 허용"
      : "광고 차단";
  return (
    <PlatformBadge
      tone={
        !policy.appUsesAds ? "neutral" : policy.adsEnabled ? "green" : "red"
      }
    >
      {label}
    </PlatformBadge>
  );
}

export function PlatformAdsBlockReasons({
  reasons,
}: {
  reasons: PlatformUserAds["policy"]["disabledBy"];
}) {
  if (reasons.length === 0) return <>없음</>;
  return (
    <>
      {reasons
        .map((reason) => (reason === "operator" ? "운영자 차단" : "ad_free"))
        .join(" + ")}
    </>
  );
}
