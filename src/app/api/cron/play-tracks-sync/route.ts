import { after, NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import {
  listGooglePlayTrackReleases,
} from "@/lib/google-play/tracks-fetcher";
import {
  applyGooglePlayTrackRelease,
} from "@/lib/google-play/tracks-collector";
import type { GoogleServiceAccountClaims } from "@/lib/google-play/service-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseServiceAccountClaims(
  raw: string | undefined,
): GoogleServiceAccountClaims {
  if (!raw) {
    return { client_email: "", private_key: "" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GoogleServiceAccountClaims>;
    return {
      client_email: typeof parsed.client_email === "string" ? parsed.client_email : "",
      private_key: typeof parsed.private_key === "string" ? parsed.private_key : "",
      token_uri: typeof parsed.token_uri === "string" ? parsed.token_uri : undefined,
    };
  } catch {
    return { client_email: "", private_key: "" };
  }
}

function verifyCronSecret(input: {
  provided: string | null;
  expected: string | null;
}): boolean {
  if (!input.expected) return false;
  if (!input.provided) return false;
  if (input.provided.length !== input.expected.length) return false;
  let mismatched = 0;
  for (let i = 0; i < input.provided.length; i += 1) {
    if (input.provided.charCodeAt(i) !== input.expected.charCodeAt(i)) {
      mismatched += 1;
    }
  }
  return mismatched === 0;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cronSecret = env.get("GOOGLE_PLAY_TRACKS_SYNC_TOKEN");
  const provided =
    req.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      ?.trim() ?? null;
  if (!verifyCronSecret({ provided, expected: cronSecret ?? null })) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    forceAppIds?: string[];
  };
  const apps = await prisma.app.findMany({
    where: {
      playPackage: { not: null },
      ...(body.forceAppIds ? { id: { in: body.forceAppIds } } : {}),
      marketTargets: { path: ["play"], equals: true } as never,
    },
    select: { id: true, displayName: true, playPackage: true },
  });

  const claims = parseServiceAccountClaims(env.get("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"));
  if (!claims.client_email || !claims.private_key) {
    return NextResponse.json(
      {
        ok: false,
        error: "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON missing or malformed",
      },
      { status: 503 },
    );
  }

  after(async () => {
    for (const app of apps) {
      if (!app.playPackage) continue;
      try {
        const editId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const releases = await listGooglePlayTrackReleases({
          packageName: app.playPackage,
          editId,
          claims,
        });
        const observedAt = new Date();
        for (const release of releases) {
          await applyGooglePlayTrackRelease({
            appId: app.id,
            appDisplayName: app.displayName ?? app.id,
            packageName: app.playPackage,
            release,
            sourceEventAt: observedAt,
          });
        }
      } catch {
        // cron 잡의 실패는 다음 cron tick 에서 재시도. 별도 텔레메트리.
      }
    }
  });

  return NextResponse.json(
    {
      ok: true,
      scheduled: apps.length,
      note: "processing delegated to background worker",
    },
    { status: 202 },
  );
}

export function GET(): NextResponse {
  return NextResponse.json({ ok: true, route: "play-tracks-sync" });
}
