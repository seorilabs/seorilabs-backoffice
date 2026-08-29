import { NextRequest, NextResponse } from "next/server";
import { sourceShaSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateGitHubActionsStaticManifestRequest } from "@/lib/control-plane/github-actions-oidc";
import { authenticateInternalRequest } from "@/lib/control-plane/security";
import { resolveManifest, resolveStaticRuntimeManifest } from "@/lib/control-plane/service";

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
    if (request.nextUrl.searchParams.get("schema") === "workflow-bundle-v5-static") {
      const allowedKeys = new Set(["ref", "application_ref", "schema"]);
      if (
        [...request.nextUrl.searchParams.keys()].some((key) => !allowedKeys.has(key))
        || [...allowedKeys].some((key) => request.nextUrl.searchParams.getAll(key).length !== 1)
      ) {
        return NextResponse.json({ error: "invalid query" }, { status: 400 });
      }
      const applicationSourceSha = sourceShaSchema.parse(
        request.nextUrl.searchParams.get("application_ref"),
      );
      const identity = await authenticateGitHubActionsStaticManifestRequest(request, {
        repositoryId: repoId.toString(),
        applicationSourceSha,
        bindingSourceSha: sourceSha,
      });
      if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      const response = await resolveStaticRuntimeManifest({
        identity,
        signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
        snapshotSignatureKeyId: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_ID ?? "",
        snapshotSignaturePolicyRevision:
          process.env.CONTROL_PLANE_SNAPSHOT_SIGNATURE_POLICY_REVISION ?? "",
      });
      return NextResponse.json(response, {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
    }
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
