"use server";

import {
  PlatformApiError,
  type PlatformAdClaim,
  type PlatformAdsConfig,
  type PlatformAdsHealth,
  type PlatformUserAds,
} from "@/lib/platform/client";
import {
  PlatformAccessError,
  requirePlatformReadAccess,
} from "@/lib/platform/access";
import { createPlatformReadClient } from "@/lib/platform/read-client";
import {
  normalizePlatformReference,
  PlatformReadInputError,
} from "@/lib/platform/read-contract";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string };
function failure(error: unknown): Result<never> {
  if (error instanceof PlatformAccessError)
    return { ok: false, code: "forbidden", error: error.message };
  if (error instanceof PlatformReadInputError)
    return { ok: false, code: "invalid_input", error: error.message };
  if (error instanceof PlatformApiError)
    return { ok: false, code: error.code, error: error.message };
  return {
    ok: false,
    code: "platform_unavailable",
    error: "광고 플랫폼을 조회하지 못했습니다.",
  };
}

export async function loadPlatformAdsHealthAction(): Promise<
  Result<PlatformAdsHealth>
> {
  try {
    await requirePlatformReadAccess();
    return { ok: true, data: await createPlatformReadClient().adsHealth() };
  } catch (error) {
    return failure(error);
  }
}

export async function lookupPlatformUserAdsAction(
  reference: string,
): Promise<Result<PlatformUserAds>> {
  try {
    await requirePlatformReadAccess();
    const client = createPlatformReadClient();
    const user = await client.user(normalizePlatformReference(reference));
    const ads = await client.userAds(user.platformUserId);
    if (ads.appId !== user.appId || ads.supportCode !== user.supportCode) {
      throw new PlatformApiError(
        "platform_response_invalid",
        "광고 정책 사용자와 인증 사용자가 일치하지 않습니다.",
        200,
      );
    }
    return { ok: true, data: ads };
  } catch (error) {
    return failure(error);
  }
}

export async function loadPlatformAdClaimsAction(
  filters: Record<string, string | undefined>,
): Promise<Result<PlatformAdClaim[]>> {
  try {
    await requirePlatformReadAccess();
    return {
      ok: true,
      data: await createPlatformReadClient().adClaims({
        ...filters,
        limit: "100",
      }),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function loadPlatformAdsConfigAction(
  appId: string,
): Promise<Result<PlatformAdsConfig>> {
  try {
    await requirePlatformReadAccess();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(appId)) {
      throw new PlatformReadInputError("앱 ID 형식이 올바르지 않습니다.");
    }
    return {
      ok: true,
      data: await createPlatformReadClient().adsConfig(appId),
    };
  } catch (error) {
    return failure(error);
  }
}
