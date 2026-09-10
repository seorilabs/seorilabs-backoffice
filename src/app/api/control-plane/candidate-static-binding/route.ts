import { NextRequest, NextResponse } from "next/server";

import { candidateStaticBindingQuerySchema, readCandidateStaticBinding } from "@/lib/control-plane/candidate-static-binding";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!authenticateInternalRequest(request, "control-plane")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const keys = Object.keys(candidateStaticBindingQuerySchema.shape);
    if (keys.some((key) => request.nextUrl.searchParams.getAll(key).length !== 1)) {
      return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
    }
    const query = candidateStaticBindingQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const result = await readCandidateStaticBinding(query, {
      signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
      snapshotSignatureKeyId: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_ID ?? "",
      snapshotSignaturePolicyRevision: process.env.CONTROL_PLANE_SNAPSHOT_SIGNATURE_POLICY_REVISION ?? "",
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
