import { NextRequest, NextResponse } from "next/server";

import {
  legacyShadowImportRequestSchema,
  sourceShaSchema,
} from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest } from "@/lib/control-plane/security";
import { listLegacyShadowImports } from "@/lib/control-plane/legacy-shadow-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ repoId: string }> },
) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const { repoId: rawRepoId } = await context.params;
    const repoId = legacyShadowImportRequestSchema.shape.repoId.parse(rawRepoId);
    const rawRef = request.nextUrl.searchParams.get("ref");
    const sourceSha = rawRef ? sourceShaSchema.parse(rawRef) : undefined;
    return NextResponse.json(await listLegacyShadowImports({ repoId, sourceSha }));
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
