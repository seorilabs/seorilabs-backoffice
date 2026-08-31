import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { credentialBindingImportSchema } from "@/lib/control-plane/contracts";
import {
  importCredentialBinding,
  listCredentialBindings,
} from "@/lib/control-plane/credential-binding";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import {
  authenticateInternalRequest,
  requireIdempotencyKey,
} from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  repoId: z.coerce.bigint().positive(),
}).strict();

export async function GET(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    return NextResponse.json({ ok: true, ...(await listCredentialBindings(query.repoId)) });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  }
  try {
    const body = credentialBindingImportSchema.parse(await request.json());
    const result = await importCredentialBinding({
      request: body,
      actor: principal.id,
      idempotencyKey,
    });
    return NextResponse.json({ ok: true, ...result }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
