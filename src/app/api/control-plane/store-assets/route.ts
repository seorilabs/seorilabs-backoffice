import { NextRequest, NextResponse } from "next/server";

import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";
import { uploadStoreAsset } from "@/lib/control-plane/store-asset-upload";
import { parseStoreAssetUploadRequest } from "@/lib/control-plane/store-asset-upload-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  }
  try {
    const parsed = await parseStoreAssetUploadRequest(request);
    const result = await uploadStoreAsset({
      ...parsed,
      actor: principal.id,
      idempotencyKey,
    });
    return NextResponse.json({ ok: true, ...result }, {
      status: result.duplicate ? 200 : 201,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
