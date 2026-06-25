import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { searchVault } from "@/lib/vault/retrieve";

// 볼트 검색 결과 점검(검증용). body { q, k? }.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { q?: string; k?: number } = {};
  try {
    body = await req.json();
  } catch {
    /* empty */
  }
  const q = (body.q ?? "").trim();
  if (!q) return NextResponse.json({ error: "q 필요" }, { status: 400 });
  try {
    const hits = await searchVault(q, Math.min(body.k ?? 6, 12));
    return NextResponse.json({
      ok: true,
      count: hits.length,
      hits: hits.map((h) => ({
        path: h.path,
        heading: h.heading,
        score: Number(h.score.toFixed(4)),
        preview: h.text.slice(0, 200),
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
