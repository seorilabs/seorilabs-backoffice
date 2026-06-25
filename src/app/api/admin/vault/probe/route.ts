import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { env } from "@/lib/env";
import { embedTexts } from "@/lib/ai/embeddings";

// 임베딩 동작 실측(키 비노출). 제공자/모델/차원 확인용.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const model = env.geminiEmbedModel();
  const configured = env.geminiConfigured();
  try {
    const [vec] = await embedTexts(["임베딩 동작 확인용 테스트 문장입니다."], "query");
    return NextResponse.json({
      ok: true,
      provider: "gemini",
      model,
      configured,
      dim: vec?.length ?? 0,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, provider: "gemini", model, configured, error: (e as Error).message },
      { status: 502 },
    );
  }
}
