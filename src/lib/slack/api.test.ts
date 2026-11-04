import test from "node:test";
import assert from "node:assert/strict";
import { slackApi } from "./api";
import { renderSlackMessage } from "./message";

const response = (body: unknown, status = 200, headers = {}) => async () => new Response(JSON.stringify(body), { status, headers });

test("Slack은 HTTP 200의 ok:false를 실패로 처리한다", async () => {
  const result = await slackApi("chat.postMessage", {}, { token: "test", request: response({ ok: false, error: "missing_scope" }) });
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_scope");
  assert.equal(result.terminal, true);
});
test("429는 Retry-After를 따르고 신규 게시의 불명확한 실패는 재게시하지 않는다", async () => {
  const limited = await slackApi("chat.postMessage", {}, { token: "test", request: response({ ok: false, error: "ratelimited" }, 429, { "retry-after": "7" }) });
  assert.equal(limited.retryAfterMs, 7000);
  assert.equal(limited.terminal, false);
  const failed = await slackApi("chat.postMessage", {}, { token: "test", request: response({}, 503) });
  assert.equal(failed.error, "SLACK_DELIVERY_OUTCOME_UNKNOWN");
  assert.equal(failed.terminal, true);
  const edit = await slackApi("chat.update", {}, { token: "test", request: response({}, 503) });
  assert.equal(edit.terminal, false);
});
test("응답 유실은 새 게시 성공으로 기록하거나 자동 반복하지 않는다", async () => {
  const request = async () => { throw new Error("secret must never be returned"); };
  const result = await slackApi("chat.postMessage", {}, { token: "test", request });
  assert.equal(result.error, "SLACK_DELIVERY_OUTCOME_UNKNOWN");
  assert.equal(result.terminal, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
test("생성 API의 비정상 JSON 응답도 게시 결과 미확정으로 보존한다", async () => {
  for (const body of [null, {}, [], {ok:"true"}]) {
    const result = await slackApi("chat.postMessage",{}, {token:"test",request:response(body)});
    assert.equal(result.error,"SLACK_DELIVERY_OUTCOME_UNKNOWN");
    assert.equal(result.terminal,true);
  }
});


test("긴 순위 보고 갱신은 전체 블록으로 Slack이 대체 본문을 생성하게 한다",async()=>{
 const body=Array.from({length:120},(_,i)=>`• **앱 ${i}** · App Store · KR Games 순위권 밖 (순위권 밖 유지)`).join("\n");
 const message=renderSlackMessage(body,{embed:{title:"검색 위치 관측"}});
 const result=await slackApi("chat.update",{channel:"CTEST",ts:"1.2",...message},{token:"test",request:async(_url,init)=>{
  const sent=JSON.parse(String(init?.body));
  assert.equal("text" in sent,false);
  assert.deepEqual(sent.blocks,message.blocks);
  assert.ok(JSON.stringify(sent.blocks).includes("앱 119"));
  return new Response(JSON.stringify({ok:true,ts:"1.2"}));
 }});
 assert.equal(result.ok,true);assert.ok(message.text.length>4000);
});

test("블록 없는 갱신과 최초 게시의 원문을 보존한다",async()=>{
 const text="a".repeat(3998)+"😀"+"b".repeat(100);
 const rich=renderSlackMessage(text).blocks;
 for(const [method,blocks] of [["chat.update",undefined],["chat.update",[]],["chat.update",rich],["chat.postMessage",rich]] as const){
  const payload={text,blocks},original=structuredClone(payload);
  const result=await slackApi(method,payload,{token:"test",request:async(_url,init)=>{
   const sent=JSON.parse(String(init?.body));
   if(method==="chat.update"&&blocks?.length)assert.equal("text" in sent,false);
   else assert.equal(sent.text,text);
   if(blocks)assert.deepEqual(sent.blocks,blocks);
   return new Response(JSON.stringify({ok:true}));
  }});
  assert.equal(result.ok,true);assert.deepEqual(payload,original);
 }
});
