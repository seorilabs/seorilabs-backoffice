import assert from "node:assert/strict";
import test from "node:test";
import type {PlatformInboxRequest} from "./client";
import {preparePlatformOperation} from "./operations";
import {executePlatformOperation, type PlatformOperationsClient} from "./executor";
const requestId="123e4567-e89b-42d3-a456-426614174000";
const puid="pu_01J00000000000000000000000";
const input={operation:"platform.inbox.issue",requestId,appSlug:"starter-game",platformUserId:puid,entitlementId:"starter_test_ticket_1",title:"테스트 선물",body:"우편 수령을 확인하세요.",reason:"internal_validation",serverConfirmation:`ISSUE INBOX starter-game ${puid}`};
test("우편은 승인한 앱과 상품 및 정확한 계정 확인만 큐에 넣는다",()=>{
 assert.equal(preparePlatformOperation(input).operationKey,"platform.inbox.issue");
 for(const change of [{appSlug:"other-game"},{entitlementId:"other-product"},{serverConfirmation:"ISSUE INBOX starter-game wrong"},{title:""},{body:"a".repeat(4001)},{quantity:99}])assert.throws(()=>preparePlatformOperation({...input,...change}));
});
test("worker는 우편 제목과 계정 및 보상을 공급자에 전달하고 결과에는 원문을 남기지 않는다",async()=>{
 const prepared=preparePlatformOperation(input);let received:unknown;
 const client={async issueInbox(req: PlatformInboxRequest,actor: string){received={req,actor};return {id:"mail-id",title:req.title,body:req.body,rewards:req.rewards,expiresAt:0};}} as unknown as PlatformOperationsClient;
 const result=await executePlatformOperation({requestId,operation:prepared.operationKey,params:prepared.params,actorLogin:"operator",reason:"internal_validation"},()=>client);
 assert.equal(result.status,"success");assert.match(JSON.stringify(received),/starter_test_ticket_1/);
 assert.doesNotMatch(JSON.stringify(result),/테스트 선물|pu_01J|우편 수령/);
 assert.equal((result.data as {messageIdHash:string}).messageIdHash.length,64);
});
test("서버가 다른 보상을 반환하면 완료로 기록하지 않는다",async()=>{
 const prepared=preparePlatformOperation(input);
 const client={async issueInbox(req: PlatformInboxRequest){return {id:"mail-id",title:req.title,body:req.body,rewards:[],expiresAt:0};}} as unknown as PlatformOperationsClient;
 await assert.rejects(()=>executePlatformOperation({requestId,operation:prepared.operationKey,params:prepared.params,actorLogin:"operator",reason:"internal_validation"},()=>client),{name:"PlatformOperationUnknownOutcomeError"});
});
