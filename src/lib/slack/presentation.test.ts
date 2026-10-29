import test from "node:test";
import assert from "node:assert/strict";
import { renderSlackMessage, renderSlackMessages } from "@/lib/notifications/channel";
import { parseExternalNotification } from "@/lib/notifications/external-contract";

test("Markdown은 제목, 목록, 인용, 코드와 링크로 렌더링하고 접근성 본문을 만든다", () => {
  const result = renderSlackMessage("# 수집 결과\n\n**성공** [보고서](https://example.com/report?a=1&b=2)\n\n- 첫 항목\n- 둘째 항목\n\n> 인용\n\n```ts\nconst n = 0;\n```\n\n<!channel> <@U123>");
  const json = JSON.stringify(result.blocks);
  assert.match(json, /rich_text_list/);
  assert.match(json, /rich_text_quote/);
  assert.match(json, /rich_text_preformatted/);
  assert.match(json, /"bold":true/);
  assert.equal(result.text.includes("**"), false);
  assert.match(result.text, /보고서.*https:\/\/example.com/);
  assert.equal(json.includes('"type":"user"'), false);
  assert.equal(json.includes('"type":"broadcast"'), false);
});

test("선택형 표시는 실제 0과 미제공, 한국 시각, 긴 제목과 안전한 링크를 유지한다", () => {
  const value = renderSlackMessage("호환 본문", {presentation:{title:"광고 보상 지급 완료",fields:[{label:"수량",value:0},{label:"항목",value:null}],context:["제공사 admob"],timestamp:"2026-10-29T00:00:00Z",links:[{label:"원문 보기",url:"https://example.com/a"}]}});
  assert.match(value.text,/수량: 0/); assert.match(value.text,/항목: 미제공/); assert.match(value.text,/09:00/);
  assert.equal(value.text.includes("호환 본문"),false);
});

test("긴 기사는 기사 경계에서 이어 보내며 버튼과 이미지를 잘라내지 않는다", () => {
  const pages=renderSlackMessages("호환 본문",{presentation:{layout:"newsletter",title:"오늘의 뉴스",items:Array.from({length:30},(_,i)=>({title:`기사 ${i+1}`,summary:"긴 요약 ".repeat(400),url:`https://example.com/${i}`}))},receipt:{fileId:"FTEST",checksum:"test",fileIds:["FTEST"],complete:true,uploaded:true},inlineImage:true,components:[{type:1,components:[{type:2,style:3,label:"확인",custom_id:"confirm"},{type:2,style:2,label:"취소",custom_id:"cancel"}]}]});
  assert.ok(pages.length>1);
  for(const page of pages){assert.ok(page.blocks.length<=50);assert.ok(page.text.length<=40000);}
  for(let i=1;i<=30;i++)assert.equal(pages.filter(p=>p.text.includes(`기사 ${i}\n`)).length,1);
  const last=pages.at(-1)!;
  assert.ok(last.blocks.some(b=>b.type==="actions")); assert.ok(last.blocks.some(b=>b.type==="image"));
  assert.equal(JSON.stringify(pages).includes("이하 생략"),false);
});

test("기존 NATS 계약과 선택형 기사 정보를 함께 받는다",()=>{
 const base={version:1,id:"news-1",source:"news",text:"기존 본문"};
 assert.equal(parseExternalNotification(base).text,base.text);
 const presentation={layout:"newsletter",title:"뉴스 2건",items:[{title:"첫 기사",summary:"요약",url:"https://example.com/a"}]};
 assert.deepEqual(parseExternalNotification({...base,presentation}).presentation,presentation);
 assert.throws(()=>parseExternalNotification({...base,presentation:{...presentation,items:[{title:"기사",summary:"요약",url:"javascript:alert(1)"}]}}));
});

test("연속편 재시도는 확인된 페이지를 편집하고 불명확한 게시를 반복하지 않는다",async()=>{
  const {createChannelMessage,editChannelMessage}=await import("@/lib/notifications/channel");
  const original=globalThis.fetch;
  let root:string|undefined;let pages:import("@/lib/notifications/channel").MessagePageReceipt[]=[];let posts=0;
  const text="긴 본문 ".repeat(12000);
  const options={botToken:"test",persistPages:async(value:typeof pages)=>{pages=structuredClone(value);},created:async(value:{ok:boolean;messageId?:string})=>{if(value.ok)root=value.messageId;}};
  globalThis.fetch=async(input,init)=>{
    if(String(input).endsWith("chat.update"))return Response.json({ok:true,ts:JSON.parse(String(init?.body)).ts});
    posts++; if(posts===2)throw new Error("합성 연결 종료");
    return Response.json({ok:true,ts:"2200000000.000001"});
  };
  try {
    assert.equal((await createChannelMessage("CTEST",text,options)).error,"SLACK_DELIVERY_OUTCOME_UNKNOWN");
    assert.ok(root);assert.equal(pages[0].state,"STARTED");
    assert.equal((await editChannelMessage("CTEST",root,text,{...options,pages})).error,"SLACK_DELIVERY_OUTCOME_UNKNOWN");
    assert.equal(posts,2);
  }finally{globalThis.fetch=original;}
});

test("광고 보상의 0과 미제공, 결제의 실제와 테스트 및 미확인을 구분한다", async()=>{
 const {operationalInterestCard}=await import("@/lib/platform/operational-events");
 const event={version:1 as const,eventId:"synthetic_event_12345",occurredAt:"2026-10-29T00:00:00Z",appId:"sample",outcome:"delivered"};
 for(const rewardAmount of [0,undefined]){
  const card=operationalInterestCard({...event,type:"ad.reward.delivered",attributes:{provider:"admob",...(rewardAmount===undefined ? {} : {rewardAmount})}},"예제 앱");
  const message=renderSlackMessage(card.text,{presentation:card.presentation});
  assert.match(message.text,/광고 보상 지급 완료/);assert.match(message.text,rewardAmount===0 ? /지급 수량: 0/ : /지급 수량: 미제공/);
 }
 for(const [isTestPurchase,label] of [[true,"테스트 주문"],[false,"실제 주문"],[undefined,"실제·테스트 여부 제공 안됨"]] as const){
  const card=operationalInterestCard({...event,type:"iap.granted",attributes:{platform:"appstore",...(isTestPurchase===undefined ? {} : {isTestPurchase})}},"예제 앱");
  assert.ok(renderSlackMessage(card.text,{presentation:card.presentation}).text.includes(label));
 }
});

test("접근성 본문에도 버튼과 이미지 설명을 포함한다",()=>{
 const message=renderSlackMessage("결과",{embed:{title:"보고서"},receipt:{fileId:"FTEST",checksum:"s",fileIds:["FTEST"],uploaded:true,complete:true},inlineImage:true,components:[{type:1,components:[{type:2,style:3,label:"확인",custom_id:"confirm"},{type:2,style:2,label:"취소",custom_id:"cancel"}]}]});
 assert.match(message.text,/동작: 확인, 취소/);assert.match(message.text,/보고서/);
});
