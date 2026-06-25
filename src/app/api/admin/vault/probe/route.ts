import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { env } from "@/lib/env";
import { miniMaxEmbed } from "@/lib/ai/embeddings";

// 임베딩 엔드포인트 동작 실측(키 비노출). GroupId 필요 여부/차원 확인용.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const groupIdSet = Boolean(env.minimaxGroupId().trim());
  const model = env.minimaxEmbedModel();
  try {
    const [vec] = await miniMaxEmbed(["임베딩 동작 확인용 테스트 문장입니다."], "query");
    return NextResponse.json({
      ok: true,
      model,
      groupIdSet,
      dim: vec?.length ?? 0,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, model, groupIdSet, error: (e as Error).message },
      { status: 502 },
    );
  }
}
