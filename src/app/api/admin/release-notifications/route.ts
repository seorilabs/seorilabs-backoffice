import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { handleReleaseNotification, releaseNotificationStatus } from "@/lib/notifications/release-notifications";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(req:NextRequest){
 const result=await handleReleaseNotification(req.headers.get("x-admin-token"),process.env.INTERNAL_ADMIN_TOKEN,()=>req.text());
 return NextResponse.json(result.body,{status:result.status});
}
export async function GET(req:NextRequest){
 if(!verifyStaticToken(req.headers.get("x-admin-token"),process.env.INTERNAL_ADMIN_TOKEN))return NextResponse.json({error:"unauthorized"},{status:401});
 const status=await releaseNotificationStatus(req.nextUrl.searchParams.get("id")??"");
 return NextResponse.json(status??{error:"not found"},{status:status?200:404});
}
