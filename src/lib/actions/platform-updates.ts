"use server";

import { revalidatePath } from "next/cache";

import { publicActionError } from "@/lib/platform/action-errors";
import { env } from "@/lib/env";
import {
  PlatformAccessError,
  requirePlatformReadAccess,
  requirePlatformWriteAccess,
} from "@/lib/platform/access";
import { resolvedPlatformAppId } from "@/lib/platform/app-id";
import { createPlatformReadClient } from "@/lib/platform/read-client";
import {
  PlatformOperationInputError,
  preparePlatformOperation,
} from "@/lib/platform/operations";
import {
  PlatformBlockingOperationError,
  enqueuePlatformOperation,
} from "@/lib/platform/runs";
import {
  blastRadiusAuditPayload,
  evaluateUpdateBlastRadius,
  type UpdateBlastRadius,
} from "@/lib/platform/update-guard";
import {
  addedBlockedVersions,
  joinVersions,
  platformUpdatePolicyConfirmationText,
  UPDATE_POLICY_PLATFORMS,
  type PlatformUpdatePolicyReason,
  type UpdatePolicyPlatformInput,
  type UpdatePolicyView,
} from "@/lib/platform/update-policy";
import { loadPlatformVersionDistributions } from "@/lib/platform/version-distribution";
import type { PlatformBlockingReference } from "@/lib/platform/recovery";
import { prisma } from "@/lib/prisma";

export interface LoadUpdatePolicyResult {
  ok: boolean;
  policy?: UpdatePolicyView;
  error?: string;
}

/** 콘솔이 현재 정책과 고를 수 있는 버전 후보를 읽는다. */
export async function loadUpdatePolicyAction(
  appId: string,
): Promise<LoadUpdatePolicyResult> {
  try {
    await requirePlatformReadAccess();
    const policy = await createPlatformReadClient().updatePolicy(appId);
    return { ok: true, policy };
  } catch (error) {
    return {
      ok: false,
      error: publicActionError(error, "업데이트 정책을 읽지 못했습니다."),
    };
  }
}

export interface SaveUpdatePolicyInput {
  requestId: string;
  appSlug: string;
  platforms: UpdatePolicyPlatformInput[];
  reason: PlatformUpdatePolicyReason;
}

export interface SaveUpdatePolicyResult {
  ok: boolean;
  requestId?: string;
  blastRadius?: UpdateBlastRadius;
  blockingReference?: PlatformBlockingReference;
  error?: string;
}

/**
 * 정책 변경을 큐에 넣는다.
 *
 * 웹 Pod에는 write 자격증명이 없다. 실제 호출은 AppOps worker가 한다.
 *
 * 확인 문구는 여기서 만든다. "새로 추가되는 강제 대상"을 알려면 현재 정책이
 * 있어야 하는데, 그건 read 자격증명으로만 읽을 수 있다.
 */
export async function saveUpdatePolicyAction(
  input: SaveUpdatePolicyInput,
): Promise<SaveUpdatePolicyResult> {
  try {
    await requirePlatformReadAccess();
    if (!env.featurePlatformWrites()) {
      throw new PlatformAccessError(
        "플랫폼 변경 기능이 아직 활성화되지 않았습니다.",
      );
    }

    const app = await prisma.app.findFirst({
      where: {
        OR: [
          { platformAppId: input.appSlug },
          { platformAppId: null, slug: input.appSlug },
        ],
      },
      select: { slug: true, platformAppId: true, displayName: true },
    });
    if (!app) throw new PlatformOperationInputError("등록되지 않은 앱입니다.");
    const platformAppId = resolvedPlatformAppId(app);

    const readClient = createPlatformReadClient();
    const current = await readClient.updatePolicy(platformAppId);

    // 이미 막혀 있던 버전을 유지하는 요청에는 확인 문구가 없다.
    const added = addedBlockedVersions(current.platforms, input.platforms);
    const hasAdded = UPDATE_POLICY_PLATFORMS.some(
      (platform) => added[platform].length > 0,
    );
    const confirmation = hasAdded
      ? platformUpdatePolicyConfirmationText(platformAppId, added)
      : "";

    // 서버 가드는 platform Admin API가 fail-closed로 건다. 여기서는 서버가
    // 셀 수 없는 것만 센다 -- 지금 몇 명이 막히는지.
    const [distribution] = await loadPlatformVersionDistributions([app]);
    const blastRadius = evaluateUpdateBlastRadius(
      distribution ?? null,
      input.platforms,
    );

    const prepared = preparePlatformOperation({
      operation: "platform.config.set-update-policy",
      requestId: input.requestId,
      appSlug: platformAppId,
      platforms: input.platforms
        .map((entry) => entry.platform)
        .sort()
        .join(","),
      ...platformParams(input.platforms),
      reason: input.reason,
      serverConfirmation: confirmation,
    });

    const actor = await requirePlatformWriteAccess(prepared.appSlug);
    if (actor.appSlug !== prepared.appSlug) {
      throw new Error("권한을 확인한 앱과 플랫폼 요청 앱이 일치하지 않습니다.");
    }

    await enqueuePlatformOperation({
      appId: actor.appId,
      actorLogin: actor.login,
      prepared,
      // 기본 감사는 키 이름만 남긴다. 정책은 값 자체가 감사 대상이다.
      extraAudit: {
        action: "platform.update-policy.decide",
        payload: {
          requestId: prepared.requestId,
          appId: platformAppId,
          reason: input.reason,
          ...blastRadiusAuditPayload(blastRadius, input.platforms),
        },
      },
    });

    revalidatePath("/platform/updates");
    return { ok: true, requestId: prepared.requestId, blastRadius };
  } catch (error) {
    return {
      ok: false,
      blockingReference:
        error instanceof PlatformBlockingOperationError
          ? error.reference
          : undefined,
      error: publicActionError(
        error,
        "정책 변경을 등록하지 못했습니다. request ID로 상태를 확인하세요.",
      ),
    };
  }
}

/** 플랫폼별 값을 flat scalar 파라미터로 편다. 큐가 중첩 객체를 담지 못한다. */
function platformParams(
  entries: readonly UpdatePolicyPlatformInput[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const platform of UPDATE_POLICY_PLATFORMS) {
    const entry = entries.find((item) => item.platform === platform);
    out[`${platform}BlockedVersions`] = entry
      ? joinVersions(entry.blockedVersions)
      : "";
    out[`${platform}RecommendOverride`] = entry?.recommendOverride ?? "";
  }
  return out;
}

