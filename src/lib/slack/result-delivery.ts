import { respondSlack, slackApi } from "./api";
import type { SlackMessage } from "./message";

/** 응답 URL은 5회까지만 사용하며 연속편도 원래 응답의 공개 범위를 유지한다. */
export async function respondSlackPages(url:string, contents:SlackMessage[], context:{channelId:string;userId:string}, ephemeral:boolean):Promise<void> {
  for(const [index,content] of contents.entries()) {
    if(index<5) {
      if(!await respondSlack(url,{...content,response_type:ephemeral ? "ephemeral" : "in_channel",...(contents.length>1 ? {replace_original:false} : {})}))throw new Error("SLACK_RESPONSE_FAILED");
    } else {
      const sent=await slackApi(ephemeral ? "chat.postEphemeral" : "chat.postMessage",{channel:context.channelId,...(ephemeral ? {user:context.userId} : {}),...content});
      if(!sent.ok)throw new Error("SLACK_RESPONSE_FAILED");
    }
  }
}
