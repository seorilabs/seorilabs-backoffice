import { NextResponse } from "next/server";

import {
  reconcileOrganizationRepositoryDiscovery,
} from "@/lib/control-plane/repository-discovery-backfill";
import { computeRepositoryDiscoveryBackfill } from "@/lib/control-plane/repository-discovery-backfill-http";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(request: Request) {
  const result = await computeRepositoryDiscoveryBackfill(
    request.headers.get("x-admin-token"),
    process.env.INTERNAL_ADMIN_TOKEN,
    () => reconcileOrganizationRepositoryDiscovery({
      organization: env.githubOrg(),
      mode: process.env.REPOSITORY_DISCOVERY_BACKFILL_MODE,
    }),
  );
  return NextResponse.json(result.body, { status: result.status });
}
