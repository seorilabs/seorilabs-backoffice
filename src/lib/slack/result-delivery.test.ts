import test from "node:test";
import assert from "node:assert/strict";
import { deliverResult } from "./interactions";
import type { SlackIngress } from "./normalize";
import { EPHEMERAL_FLAG } from "@/lib/operator/types";
test("긴 비공개 명령 응답은 덮어쓰지 않고 응답 URL 5회 이후에도 비공개를 유지한다",async()=>{
 const original=globalThis.fetch,token=process.env.SLACK_BOT_TOKEN;
 process.env.SLACK_BOT_TOKEN="test";
 const calls:{url:string;body:Record<string,unknown>}[]=[];
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),body:JSON.parse(String(init?.body))});return Response.json({ok:true,ts:"2200000000.000001"});};
 try{
  await deliverResult({context:{channelId:"CTEST",userId:"UTEST"},responseUrl:"https://hooks.slack.com/actions/synthetic",interaction:{}} as SlackIngress,{type:4,data:{content:"검증 본문 ".repeat(35000)+"마지막 내용",flags:EPHEMERAL_FLAG}});
  assert.ok(calls.length>5);assert.equal(calls.filter(c=>c.url.startsWith("https://hooks.slack.com/")).length,5);
  for(const call of calls){if(call.url.startsWith("https://hooks.slack.com/")){assert.equal(call.body.replace_original,false);assert.equal(call.body.response_type,"ephemeral");}else{assert.equal(call.url,"https://slack.com/api/chat.postEphemeral");assert.equal(call.body.user,"UTEST");}}
  assert.match(String(calls.at(-1)!.body.text),/마지막 내용/);
 }finally{globalThis.fetch=original;if(token===undefined)delete process.env.SLACK_BOT_TOKEN;else process.env.SLACK_BOT_TOKEN=token;}
});
