import Link from "next/link";
import {PlatformInboxConsole} from "@/components/platform/PlatformInboxConsole";
import {requirePlatformReadAccess,requirePlatformWriteAccess} from "@/lib/platform/access";
import {env} from "@/lib/env";
export const dynamic="force-dynamic";
export default async function PlatformInboxPage(){
 await requirePlatformReadAccess();
 let enabled=false;
 if(env.featurePlatformWrites())try {await requirePlatformWriteAccess("starter-game");enabled=true;}catch {/* The form stays read-only without current app ownership. */}
 return <section className="space-y-4"><h2 className="text-lg font-semibold">Starter 우편함</h2><Link href="/platform/auth" className="text-sm underline">계정 식별자 조회</Link><PlatformInboxConsole enabled={enabled}/></section>;
}
