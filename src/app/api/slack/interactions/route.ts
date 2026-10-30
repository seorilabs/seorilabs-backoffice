import { after, NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { verifySlackSignature } from "@/lib/slack/security";
import { prepareSlackRequest } from "@/lib/slack/interactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  if (!env.slackEnabled()) return NextResponse.json({error:"Slack 운영 연결 준비 중"},{status:503});
  const body = await request.text();
  if (body.length > 256000) return new NextResponse(null,{status:413});
  if (!verifySlackSignature({body,timestamp:request.headers.get("x-slack-request-timestamp"),signature:request.headers.get("x-slack-signature"),secret:env.slackSigningSecret()})) return NextResponse.json({error:"invalid signature"},{status:401});
  try {
    const response = await prepareSlackRequest(body,work => after(work));
    return response ? NextResponse.json(response) : new NextResponse(null,{status:200});
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && /^(?:SUPERVISOR_SLACK|SLACK)_(CONTEXT|SCOPE|COMMAND|REQUEST|ACTION|OPTIONS)_/.test(error.message))) return NextResponse.json({response_type:"ephemeral",text:"허용된 워크스페이스의 운영명령 채널에서 /seori help를 확인하세요."},{status:200});
    console.error("[slack] 요청 저장 실패");
    return NextResponse.json({error:"request unavailable"},{status:503});
  }
}
