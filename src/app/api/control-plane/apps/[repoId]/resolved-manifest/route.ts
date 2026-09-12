import { NextRequest, NextResponse } from "next/server";
import { sourceShaSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest } from "@/lib/control-plane/security";
import { resolveManifest } from "@/lib/control-plane/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ repoId: string }> },
) {
  try {
    const { repoId: rawRepoId } = await context.params;
    if (!/^[1-9][0-9]{0,31}$/.test(rawRepoId)) {
      return NextResponse.json({ error: "invalid repoId" }, { status: 400 });
    }
    const repoId = BigInt(rawRepoId);
    const sourceSha = sourceShaSchema.parse(request.nextUrl.searchParams.get("ref"));
    const principal = authenticateInternalRequest(request, "control-plane");
    if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const market = request.nextUrl.searchParams.get("market")?.trim() || undefined;
    const revisionValue = request.nextUrl.searchParams.get("revision");
    const revision = revisionValue ? Number(revisionValue) : undefined;
    if (revision !== undefined && (!Number.isInteger(revision) || revision <= 0)) {
      return NextResponse.json({ error: "invalid revision" }, { status: 400 });
    }
    return NextResponse.json(await resolveManifest({
      repoId,
      sourceSha,
      market,
      revision,
      signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
    }));
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
