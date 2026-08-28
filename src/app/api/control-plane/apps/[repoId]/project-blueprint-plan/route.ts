import { NextRequest, NextResponse } from "next/server";
import { sourceShaSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { getProjectBlueprintPlan } from "@/lib/control-plane/project-blueprint-service";
import { authenticateInternalRequest } from "@/lib/control-plane/security";

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
    const repoId = BigInt(rawRepoId);
    if (repoId <= 0n) throw new Error("invalid repoId");
    const sourceSha = sourceShaSchema.parse(request.nextUrl.searchParams.get("ref"));
    const revision = Number(request.nextUrl.searchParams.get("revision"));
    if (!Number.isInteger(revision) || revision <= 0) {
      return NextResponse.json({ error: "invalid revision" }, { status: 400 });
    }
    return NextResponse.json(await getProjectBlueprintPlan({ repoId, sourceSha, configRevision: revision }));
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
