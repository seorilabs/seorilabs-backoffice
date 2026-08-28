import { NextResponse } from "next/server";

import {
  reconcileOrganizationRepositoryDiscovery,
} from "@/lib/control-plane/repository-discovery-backfill";
import { computeRepositoryDiscoveryBackfill } from "@/lib/control-plane/repository-discovery-backfill-http";
import { recordGitHubInstallationObservations } from "@/lib/control-plane/github-installation-observation";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(request: Request) {
  const result = await computeRepositoryDiscoveryBackfill(
    request.headers.get("x-admin-token"),
    process.env.INTERNAL_ADMIN_TOKEN,
    async () => {
      const organization = env.githubOrg();
      const discovery = await reconcileOrganizationRepositoryDiscovery({
        organization,
        mode: process.env.REPOSITORY_DISCOVERY_BACKFILL_MODE,
      });
      const githubInstallation = await recordGitHubInstallationObservations({
        organization,
        occurrenceId: discovery.runId,
      });
      const failed = discovery.failed + githubInstallation.failed;
      return {
        ...discovery,
        failed,
        state: failed === 0 && discovery.state === "completed" ? "completed" : "partial",
        ok: failed === 0 && discovery.ok,
        githubInstallation,
      };
    },
  );
  return NextResponse.json(result.body, { status: result.status });
}
