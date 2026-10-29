import { NextResponse } from "next/server";
export async function POST() { return NextResponse.json({error:"운영 명령은 Slack으로 이전했습니다."},{status:410}); }
