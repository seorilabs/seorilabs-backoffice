import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { generateAndPublishReleaseNotes } from "@/lib/core/release-ops";

// 출시노트 수동 백필/재생성. body { repo, version, headSha? }. x-admin-token 보호.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { repo?: string; version?: string; headSha?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty */
  }
  const repo = (body.repo ?? "").trim();
  const version = (body.version ?? "").trim();
  if (!repo || !version) {
    return NextResponse.json({ error: "repo, version 필요" }, { status: 400 });
  }
  try {
    const r = await generateAndPublishReleaseNotes({
      repoFullName: repo.includes("/") ? repo : `seorilabs/${repo}`,
      version,
      headSha: body.headSha,
    });
    if (!r) return NextResponse.json({ ok: false, error: "미등록 repo 또는 MiniMax 미구성" }, { status: 400 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
