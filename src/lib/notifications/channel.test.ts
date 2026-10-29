import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createChannelMessage, deletedMessageReplacement, editChannelMessage, renderSlackMessage, slackText, type FileReceipt } from "./channel";
import { isUnreusableCard } from "./deploy";
import { slackApi } from "@/lib/slack/api";

function requestBody(init?: RequestInit): Record<string, unknown> {
  const contentType = new Headers(init?.headers).get("content-type") ?? "";
  return contentType.startsWith("application/x-www-form-urlencoded")
    ? Object.fromEntries(new URLSearchParams(String(init?.body)))
    : JSON.parse(String(init?.body ?? "{}"));
}

test("Slack 본문은 임의 멘션을 이스케이프하고 링크와 굵은 글씨를 유지한다", () => {
  assert.equal(slackText("**결론** [근거](https://example.com/a) <!channel> <@U123>"),"*결론* <https://example.com/a|근거> &lt;!channel&gt; &lt;@U123&gt;");
  const value=renderSlackMessage("본문",{embed:{title:"제목",footer:"기간"},components:[{type:1,components:[{type:2,style:4,label:"실행",custom_id:"command:confirm:run"},{type:2,style:2,label:"만료",custom_id:"old",disabled:true}]}]});
  assert.equal(value.blocks[0].type,"header");
  assert.equal(value.blocks.filter(block=>block.type==="actions").length,1);
  assert.equal(JSON.stringify(value).includes('"old"'),false);
  assert.match(JSON.stringify(value),/command:confirm:run/);
});
test("Slack 본문과 블록 상한을 지키고 잘린 사실을 남긴다", () => {
  const value=renderSlackMessage("긴 행\n".repeat(15000));
  assert.ok(value.blocks.length <= 50);
  assert.ok(value.text.length <= 40000);
  for(const block of value.blocks) if(block.type==="section") assert.ok((block.text as {text:string}).text.length <= 3000);
  assert.match(JSON.stringify(value.blocks),/길이 제한으로 이하 생략/);
});
test("네이티브 스레드는 같은 채널의 thread_ts를 사용하고 별도 채널을 만들지 않는다",async()=>{
  const original=globalThis.fetch; let url=""; let body:Record<string,unknown>={};
  globalThis.fetch=async(input,init)=>{url=String(input);body=JSON.parse(String(init?.body));return Response.json({ok:true,ts:"1793260000.123456",channel:"CTEST"});};
  try{
    const result=await createChannelMessage("CTEST","이슈 댓글",{botToken:"test",replyToMessageId:"1793250000.123456"});
    assert.equal(result.ok,true);assert.equal(url,"https://slack.com/api/chat.postMessage");assert.equal(body.channel,"CTEST");assert.equal(body.thread_ts,"1793250000.123456");
  }finally{globalThis.fetch=original;}
});
test("결과가 불명확한 기존 게시 시도는 다시 보내지 않는다",async()=>{
  let called=false;const original=globalThis.fetch;
  globalThis.fetch=async()=>{called=true;return Response.json({ok:true});};
  try{const result=await createChannelMessage("CTEST","본문",{botToken:"test",beforeCreate:async()=>false});assert.equal(result.error,"SLACK_DELIVERY_OUTCOME_UNKNOWN");assert.equal(called,false);}finally{globalThis.fetch=original;}
});
test("Slack 파일 업로드 영수증을 이어받아 같은 파일을 다시 게시하지 않는다",async()=>{
  const original=globalThis.fetch;let complete=0;let receipt:FileReceipt|undefined;const updates:Record<string,unknown>[]=[];
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url.startsWith("https://files.slack.com/upload/"))return new Response("ok");
    const body=requestBody(init);
    if(url.endsWith("files.getUploadURLExternal"))return Response.json({ok:true,file_id:"FTEST",upload_url:"https://files.slack.com/upload/test"});
    if(url.endsWith("files.completeUploadExternal")){complete++;return Response.json({ok:true,files:[{id:"FTEST"}]});}
    if(url.endsWith("files.info"))return Response.json({ok:true,file:{shares:{public:{CTEST:[{ts:"1793260000.123456"}]}}}});
    if(url.endsWith("chat.update")){updates.push(body);return Response.json({ok:true,ts:body.ts,channel:body.channel});}
    throw new Error("unexpected method");
  };
  const options={botToken:"test",inlineImage:true,attachment:{filename:"trend.png",contentType:"image/png",base64:Buffer.from("PNG").toString("base64")},persistReceipt:async(value:FileReceipt)=>{receipt=structuredClone(value);}};
  try{
    assert.equal((await createChannelMessage("CTEST","보고",options)).messageId,"1793260000.123456");
    assert.equal((await editChannelMessage("CTEST","1793260000.123456","정정",{...options,receipt})).ok,true);
    assert.equal(complete,1);assert.ok(receipt?.complete);assert.match(JSON.stringify(updates[1]),/slack_file/);
  }finally{globalThis.fetch=original;}
});
test("삭제된 카드만 대체하며 권한 실패는 새 게시로 우회하지 않는다",()=>{
  assert.equal(isUnreusableCard({error:"message_not_found"}),true);
  for(const error of ["cant_update_message","missing_scope","ratelimited","SLACK_HTTP_503"]) assert.equal(isUnreusableCard({error}),false);
});

test("Slack 조회와 파일 할당은 form을 사용하고 메시지 블록은 JSON으로 보낸다", async () => {
  for (const [method, payload] of [
    ["users.info", { user: "UTEST" }],
    ["files.info", { file: "FTEST" }],
    ["files.delete", { file: "FTEST" }],
    ["files.getUploadURLExternal", { filename: "검수 보고.png", length: 123 }],
    ["conversations.info", { channel: "CTEST" }],
    ["conversations.members", { channel: "CTEST", limit: 100 }],
    ["conversations.list", { types: "public_channel,private_channel", limit: 100 }],
  ] as const) {
    let requests = 0;
    const result = await slackApi(method, payload, { token: "test", request: async (input, init) => {
      requests++;
      assert.equal(String(input), `https://slack.com/api/${method}`);
      assert.equal(init?.method, "POST");
      assert.match(new Headers(init?.headers).get("content-type") ?? "", /^application\/x-www-form-urlencoded/);
      assert.deepEqual(requestBody(init), Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, String(value)])));
      return Response.json({ ok: true });
    } });
    assert.equal(result.ok, true, method);
    assert.equal(requests, 1, method);
  }
  const payload = { channel: "CTEST", ts: "2200000000.000001", blocks: [{ type: "section", text: { type: "mrkdwn", text: "본문" } }] };
  const result = await slackApi("chat.update", payload, { token: "test", request: async (_input, init) => {
    assert.match(new Headers(init?.headers).get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(requestBody(init), payload);
    return Response.json({ ok: true, ts: payload.ts });
  } });
  assert.equal(result.messageId, payload.ts);
});

test("삭제된 첨부 카드는 새 파일과 메시지로 대체하고 이전 파일의 정리 기록을 보존한다", async () => {
  const original = globalThis.fetch;
  const bytes = Buffer.from("합성 보고서");
  const oldTs = "2200000000.000001", newTs = "2200000000.000002";
  const oldReceipt: FileReceipt = { checksum: createHash("sha256").update(bytes).digest("hex"), fileId: "FOLD", uploaded: true, complete: true, messageTs: oldTs, fileIds: ["FOLD"] };
  let receipt = structuredClone(oldReceipt), posts = 0;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "https://files.slack.com") {
      assert.equal(url.pathname, "/upload/synthetic");
      calls.push("upload");
      assert.deepEqual(init?.body, bytes);
      return new Response("ok");
    }
    assert.equal(url.origin, "https://slack.com");
    const method = url.pathname.slice(5), body = requestBody(init);
    calls.push(method);
    if (method === "chat.update") {
      assert.equal(body.channel, "CTEST");
      if (body.ts === oldTs) return Response.json({ ok: false, error: "message_not_found" });
      assert.equal(body.ts, newTs);
      assert.match(JSON.stringify(body.blocks), /FNEW/);
      return Response.json({ ok: true, channel: "CTEST", ts: newTs });
    }
    if (method === "files.getUploadURLExternal") {
      assert.equal(body.length, String(bytes.length));
      return Response.json({ ok: true, file_id: "FNEW", upload_url: "https://files.slack.com/upload/synthetic" });
    }
    if (method === "files.completeUploadExternal") {
      assert.deepEqual(body.files, [{ id: "FNEW", title: "report.png" }]);
      assert.equal(body.channel_id, "CTEST");
      assert.equal(body.thread_ts, undefined, "삭제된 메시지 아래에 파일을 공유하지 않는다");
      return Response.json({ ok: true, files: [{ id: "FNEW" }] });
    }
    if (method === "files.info") return Response.json({ ok: true, file: { shares: { public: { CTEST: [{ ts: newTs }] } } } });
    assert.fail(`예상하지 않은 Slack API: ${method}`);
  };
  const options = { botToken: "test", inlineImage: true, attachment: { filename: "report.png", contentType: "image/png", base64: bytes.toString("base64") }, receipt: oldReceipt, persistReceipt: async (value: FileReceipt) => { receipt = structuredClone(value); }, beforeCreate: async () => { posts++; return true; } };
  try {
    const edited = await editChannelMessage("CTEST", oldTs, "수정 보고", options);
    assert.equal(edited.error, "message_not_found");
    assert.deepEqual(calls, ["chat.update"], "삭제 여부 확인 전에 파일을 새로 올리지 않는다");
    const replacement = await createChannelMessage("CTEST", "수정 보고", deletedMessageReplacement(options));
    assert.equal(replacement.messageId, newTs);
    assert.equal(posts, 1);
    assert.deepEqual(calls, ["chat.update", "files.getUploadURLExternal", "upload", "files.completeUploadExternal", "files.info", "chat.update"]);
    assert.deepEqual(receipt.fileIds, ["FOLD", "FNEW"]);
    assert.equal(receipt.messageTs, newTs);
    assert.equal(oldReceipt.messageTs, oldTs);
    assert.equal(oldReceipt.checksum, createHash("sha256").update(bytes).digest("hex"));
  } finally { globalThis.fetch = original; }
});

test("인라인 그래프는 기본 파일 미리보기만 비우고 일반 첨부는 유지한다", async () => {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://slack.com/api/chat.update");
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return Response.json({ok:true,ts:body.ts,channel:body.channel});
  };
  const receipt: FileReceipt = {checksum:"png-hash",fileId:"FCHART",uploaded:true,complete:true,messageTs:"2200000000.000001",fileIds:["FCHART"]};
  try {
    assert.equal((await editChannelMessage("CTEST","2200000000.000001","그래프",{botToken:"test",inlineImage:true,receipt})).ok,true);
    assert.deepEqual(bodies[0].file_ids,[]);
    assert.equal((bodies[0].blocks as {type:string}[]).filter(block=>block.type==="image").length,1);
    assert.equal((await editChannelMessage("CTEST","2200000000.000001","CSV 첨부",{botToken:"test",inlineImage:false,receipt})).ok,true);
    assert.equal(Object.hasOwn(bodies[1],"file_ids"),false);
    assert.equal((bodies[1].blocks as {type:string}[]).filter(block=>block.type==="image").length,0);
  } finally { globalThis.fetch=original; }
});
