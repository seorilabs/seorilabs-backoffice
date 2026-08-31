import { NextRequest, NextResponse } from "next/server";

import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { requireIdempotencyKey } from "@/lib/control-plane/security";
import { uploadStoreAsset } from "@/lib/control-plane/store-asset-upload";
import {
  isTrustedStoreAssetUiOrigin,
  parseStoreAssetUploadRequest,
} from "@/lib/control-plane/store-asset-upload-request";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { PlatformAccessError, requirePlatformWriteAccess } from "@/lib/platform/access";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ appId: string }> },
) {
  if (!isTrustedStoreAssetUiOrigin({
    requestUrl: request.url,
    origin: request.headers.get("origin"),
    authUrl: process.env.AUTH_URL,
    nodeEnv: process.env.NODE_ENV,
  })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  }
  try {
    const { appId } = await context.params;
    const app = await prisma.app.findFirst({
      where: { id: appId, ...visibleAppWhere },
      select: { id: true, slug: true, repoId: true },
    });
    if (!app?.repoId) {
      throw new ControlPlaneError(
        "GitHub numeric repo ID가 있는 Fleet 앱을 찾을 수 없습니다.",
        404,
        "APP_NOT_FOUND",
      );
    }
    const actor = await requirePlatformWriteAccess(app.slug);
    if (actor.appId !== app.id) {
      throw new PlatformAccessError("Fleet 앱 권한 결합이 일치하지 않습니다.");
    }
    const parsed = await parseStoreAssetUploadRequest(request, app.repoId);
    const result = await uploadStoreAsset({
      ...parsed,
      actor: actor.login,
      idempotencyKey,
    });
    return NextResponse.json({ ok: true, ...result }, {
      status: result.duplicate ? 200 : 201,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    if (error instanceof PlatformAccessError) {
      return NextResponse.json({ error: "forbidden", message: error.message }, { status: 403 });
    }
    return controlPlaneErrorResponse(error);
  }
}
