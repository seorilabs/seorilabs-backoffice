import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { slackExamples } from "@/lib/slack/examples";
import { createChannelMessage, renderSlackMessages } from "@/lib/notifications/channel";

async function main(){
 const args=process.argv.slice(2),out=args[args.indexOf("--out")+1];
 if(!args.includes("--out") || !out)throw new Error("--out 경로가 필요합니다");
 await mkdir(out,{recursive:true});
 const posting=args.includes("--post"),channel=process.env.SLACK_CHANNEL_PRIVATE_FEED ?? "";
 if(posting && !/^[CG][A-Z0-9]+$/.test(channel))throw new Error("검증 목적지 미설정");
 const records=[];
 const image=await sharp(Buffer.from('<svg width="900" height="300"><rect width="900" height="300" fill="#f4f6fa"/><text x="40" y="55" font-size="28" fill="#243447">SYNTHETIC: daily revenue (KRW)</text><path d="M50 240 L200 180 L350 195 L500 110 L650 130 L800 70" fill="none" stroke="#1d6e50" stroke-width="8"/><text x="40" y="280" font-size="20">Example only: 12,000 / 15,000 / 14,000 / 20,000 / 18,000 / 32,000</text></svg>')).png().toBuffer();
 for(const example of slackExamples){
   const options=structuredClone(example.options);
   const prefix=`[합성 검증 ${example.id}] `;
   if(options.presentation)options.presentation.title=prefix+options.presentation.title;
   else if(options.embed && !options.plain)options.embed.title=prefix+(options.embed.title ?? "");
   const text=options.plain ? prefix+example.text : example.text;
   const rendered=renderSlackMessages(text,options);
   let messageId:string|undefined;
   if(posting){
     if(example.image || example.id === "weather") {options.attachment={filename:`synthetic-${example.id}.png`,contentType:"image/png",base64:image.toString("base64")};options.inlineImage=true;}
     const result=await createChannelMessage(channel,text,options);
     if(!result.ok)throw new Error(`합성 검증 실패 ${example.id}: ${result.error}`);
     messageId=result.messageId;
     // 채널당 전송 빈도를 유지한다. 실패한 요청을 자동 재전송하지 않는다.
     await new Promise(resolve=>setTimeout(resolve,1100));
   }
   records.push({id:example.id,destination:example.destination,pages:rendered,...(messageId ? {messageId,url:`https://seorilabs.slack.com/archives/${channel}/p${messageId.replace(".","")}`} : {})});
 }
 await writeFile(path.join(out,"examples.json"),JSON.stringify(records,null,2));
 console.log(JSON.stringify({examples:records.length,posted:posting,out}));
}
main().catch(error=>{console.error(error instanceof Error ? error.message : "SLACK_PREVIEW_FAILED");process.exitCode=1;});
