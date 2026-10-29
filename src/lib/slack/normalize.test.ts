import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSlackRequest,validateSlackScope } from "./normalize";
import { InteractionType } from "@/lib/operator/types";

const identity={team_id:"TTEST",api_app_id:"ATEST",user_id:"UTEST",channel_id:"CTEST",trigger_id:"trigger"};
test("Slack 명령은 서버 역할과 provider로 구분된 요청 ID를 사용한다",()=>{
 const body=new URLSearchParams({...identity,command:"/seori",text:"app status app:happy-farm"}).toString();
 const input=normalizeSlackRequest(body,()=>["viewer"]);
 assert.equal(input.interaction.data?.name,"app status");assert.equal(input.interaction.actor?.id,"UTEST");assert.deepEqual(input.interaction.actor?.roles,["viewer"]);
 assert.match(input.interaction.id,/^slack:[a-f0-9]{64}$/);assert.equal(normalizeSlackRequest(body,()=>[]).interaction.id,input.interaction.id);
 assert.equal(validateSlackScope(input,{workspaceId:"TTEST",applicationId:"ATEST"}),true);
 assert.equal(validateSlackScope(input,{workspaceId:"TOTHER",applicationId:"ATEST"}),false);
 assert.equal(validateSlackScope(input,{workspaceId:"TTEST",applicationId:"AOTHER"}),false);
});
test("버튼 요청은 Slack 채널과 실제 사용자, 원본 메시지 ID를 보존한다",()=>{
 const body=new URLSearchParams({payload:JSON.stringify({type:"block_actions",api_app_id:"ATEST",team:{id:"TTEST"},user:{id:"UTEST"},channel:{id:"CTEST"},message:{ts:"1793260000.123456"},actions:[{action_id:"command:confirm:run"}],member:{roles:["operations_admin"]}})}).toString();
 const input=normalizeSlackRequest(body,()=>["viewer"]);
 assert.equal(input.interaction.type,InteractionType.MESSAGE_COMPONENT);assert.equal(input.context.messageId,"1793260000.123456");assert.deepEqual(input.interaction.actor?.roles,["viewer"]);
});
test("입력창은 원래 사용자와 채널을 결합하고 4천자 입력을 이어받는다",()=>{
 const now=1793260000000;const metadata={workspaceId:"TTEST",channelId:"CTEST",userId:"UTEST",createdAt:now,messageId:"1793250000.123456"};
 const payload={
  type:"view_submission",api_app_id:"ATEST",team:{id:"TTEST"},user:{id:"UTEST"},
  view:{callback_id:"operator:modal:ask:none",private_metadata:JSON.stringify(metadata),state:{values:{
   text:{text:{value:"가".repeat(3000)}},
   text__continuation:{text__continuation:{value:"나".repeat(1000)}}
  }}}
 };
 const body=()=>new URLSearchParams({payload:JSON.stringify(payload)}).toString();
 const input=normalizeSlackRequest(body(),()=>["operator"],now);
 assert.equal(input.context.channelId,"CTEST");assert.equal(input.interaction.data?.components?.[0].components?.[0].value?.length,4000);
 payload.user.id="UOTHER";assert.throws(()=>normalizeSlackRequest(body(),()=>[],now),/CONTEXT_MISMATCH/);
 payload.user.id="UTEST";assert.throws(()=>normalizeSlackRequest(body(),()=>[],now+3600001),/CONTEXT_MISMATCH/);
});
