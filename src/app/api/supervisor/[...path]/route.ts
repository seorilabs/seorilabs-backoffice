import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { machinePrincipal, requireHuman } from "@/lib/supervisor/auth";
import {
  decisionSchema,
  reportSchema,
  ensure,
  SupervisorError,
} from "@/lib/supervisor/contracts";
import {
  registerTarget,
  submitObservations,
  createProposal,
  decideProposal,
  claimRun,
  reportRun,
  supervisorSnapshot,
  beginAnalysis,
  finishAnalysis,
  setMode,
} from "@/lib/supervisor/service";
import { publishProposals } from "@/lib/supervisor/slack";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const response = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  if (error instanceof SupervisorError)
    return response({ error: error.code }, error.status);
  if (error instanceof ZodError || error instanceof SyntaxError)
    return response({ error: "INVALID_REQUEST" }, 400);
  console.error("[supervisor] request failed");
  return response({ error: "SUPERVISOR_UNAVAILABLE" }, 503);
}
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const path = (await params).path.join("/");
    const machine = machinePrincipal(request);
    if (!machine) await requireHuman(request);
    if (path === "snapshot") return response(await supervisorSnapshot());
    if (path === "sources") {
      ensure(machine, "MACHINE_REQUIRED", 403);
      const { loadRegistrationPolicy } =
        await import("@/lib/metric-issues/policy");
      const policy = await loadRegistrationPolicy(true);
      const apps = await prisma.app.findMany({
        where: {
          status: "ACTIVE",
          repoFullName: {
            in: policy.data.repositories
              .filter((r) => r.registration === "ENABLED")
              .map((r) => r.repository),
          },
        },
        select: { id: true, repoFullName: true, displayName: true },
      });
      const appIds = apps.map((a) => a.id);
      const [issues, incidents, releases, reviews, collections] =
        await Promise.all([
          prisma.issueMirror.findMany({
            where: { appId: { in: appIds }, state: "OPEN" },
            select: {
              appId: true,
              repoFullName: true,
              number: true,
              title: true,
              ghUpdatedAt: true,
              linkedPrUrl: true,
              isBlocked: true,
            },
            orderBy: { ghUpdatedAt: "desc" },
            take: 100,
          }),
          prisma.operationalIncident.findMany({
            where: {
              status: "OPEN",
              OR: [{ appId: { in: appIds } }, { appId: null }],
            },
            select: {
              id: true,
              appId: true,
              kind: true,
              summary: true,
              lastDetectedAt: true,
            },
            take: 50,
          }),
          prisma.storeReviewSubmissionObservation.findMany({
            where: { appId: { in: appIds } },
            orderBy: { lastObservedAt: "desc" },
            take: 50,
            select: {
              id: true,
              appId: true,
              lastObservedAt: true,
              state: true,
            },
          }),
          prisma.storeReviewObservation.findMany({
            where: { appId: { in: appIds }, rating: { lte: 3 } },
            orderBy: { lastObservedAt: "desc" },
            take: 50,
            select: {
              id: true,
              appId: true,
              rating: true,
              store: true,
              lastObservedAt: true,
            },
          }),
          prisma.sourceCollectionRun.findMany({
            where: { status: { in: ["FAILED", "PARTIAL"] } },
            orderBy: { startedAt: "desc" },
            take: 50,
            select: {
              id: true,
              appId: true,
              source: true,
              status: true,
              errorCode: true,
              startedAt: true,
            },
          }),
        ]);
      return response({
        policySha: policy.sha,
        apps,
        issues,
        incidents,
        releases,
        reviews,
        collections,
      });
    }
    return response({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest, { params }: Context) {
  try {
    ensure(
      Number(request.headers.get("content-length") || 0) <= 256000,
      "REQUEST_TOO_LARGE",
      413,
    );
    const path = (await params).path;
    // 사람 결정은 machine token 분기보다 먼저 독립 인증한다.
    if (
      path[0] === "proposals" &&
      path[2] === "decision" &&
      path.length === 3
    ) {
      const actor = await requireHuman(request);
      return response(
        await decideProposal({
          id: path[1],
          ...decisionSchema.parse(await request.json()),
          actor,
        }),
      );
    }
    if (path.join("/") === "mode") {
      const actor = await requireHuman(request);
      const { mode } = z
        .object({ mode: z.enum(["OBSERVE", "ACTIVE", "PAUSED"]) })
        .strict()
        .parse(await request.json());
      return response(await setMode(mode, actor));
    }
    const owner = machinePrincipal(request);
    ensure(owner, "MACHINE_REQUIRED", 401);
    const bodyText = await request.text();
    ensure(bodyText.length <= 256000, "REQUEST_TOO_LARGE", 413);
    const body = JSON.parse(bodyText || "{}");
    switch (path.join("/")) {
      case "targets":
        return response(await registerTarget(body));
      case "observations":
        return response(
          await submitObservations(z.array(z.unknown()).max(100).parse(body)),
        );
      case "proposals":
        return response(await createProposal(body, owner));
      case "runs/claim":
        return response(await claimRun(owner));
      case "analysis/begin":
        return response(await beginAnalysis(owner));
      case "analysis/finish":
        return response(
          await finishAnalysis(
            owner,
            z
              .object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
              .strict()
              .parse(body).day,
          ),
        );
      case "publish":
        return response(await publishProposals());
    }
    if (path[0] === "runs" && path[2] === "report" && path.length === 3)
      return response(
        await reportRun(path[1], owner, reportSchema.parse(body)),
      );
    return response({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    return failure(error);
  }
}
