import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { handleOperatorInteraction } from "@/lib/operator/handler";
import { hasOperatorCapability, interactionChannelKeys, isOperatorScope } from "@/lib/operator/roles";
import { InteractionResponseType, EPHEMERAL_FLAG } from "@/lib/operator/types";
import { createChannelMessage, editChannelMessage, renderSlackMessages, type MessageActionRow } from "@/lib/notifications/channel";
import { slackApi, respondSlack } from "./api";
import { normalizeSlackRequest, validateSlackScope, object, type SlackIngress, type SlackContext } from "./normalize";

type Result = { type?: number; data?: unknown };
type Block = Record<string,unknown>;
const plain = (text: string) => ({type:"plain_text",text,emoji:true});
function metadata(input: SlackIngress, extra: Partial<SlackContext> = {}) { return JSON.stringify({...input.context,createdAt:Date.now(),...extra}); }

function commandView(input: SlackIngress) {
  const definition = input.definition!;
  const blocks = definition.options.map(spec => {
    const value = input.interaction.data?.options?.find(item => item.name === spec.name)?.value;
    let element: Block;
    if (spec.autocomplete) element = {type:"external_select",action_id:spec.name,min_query_length:0,placeholder:plain("앱 선택"),...(typeof value === "string" ? {initial_option:{text:plain(value),value}} : {})};
    else if (spec.choices) element = {type:"static_select",action_id:spec.name,options:spec.choices.map(choice => ({text:plain(choice.name),value:choice.value})),...(spec.choices.some(choice => choice.value === value) ? {initial_option:{text:plain(spec.choices.find(choice => choice.value === value)!.name),value}} : {})};
    else element = {type:"plain_text_input",action_id:spec.name,max_length:1000,...(typeof value === "string" ? {initial_value:value} : {})};
    return {type:"input",block_id:spec.name,label:plain(spec.description.slice(0,2000)),optional:!spec.required,element};
  });
  return {type:"modal",callback_id:"command-input",private_metadata:metadata(input,{mode:"command",command:definition.path.join(" ")}),title:plain(definition.description.slice(0,24)),submit:plain("다음"),close:plain("취소"),blocks};
}
function operatorView(input: SlackIngress, value: unknown) {
  const data = object(value);
  const rows = Array.isArray(data.components) ? data.components : [];
  const fields = rows.flatMap(row => Array.isArray(object(row).components) ? object(row).components as unknown[] : []);
  const blocks: Block[] = [];
  for (const raw of fields) {
    const field = object(raw);
    const id = String(field.custom_id ?? "text");
    const max = Math.min(4000,Number(field.max_length ?? 4000));
    const initial = typeof field.value === "string" ? field.value : "";
    blocks.push({type:"input",block_id:id,label:plain(String(field.label ?? "입력").slice(0,2000)),optional:field.required === false,element:{type:"plain_text_input",action_id:id,multiline:field.style === 2,max_length:Math.min(3000,max),...(initial ? {initial_value:initial.slice(0,3000)} : {}),...(field.placeholder ? {placeholder:plain(String(field.placeholder).slice(0,150))} : {})}});
    if (max > 3000) blocks.push({type:"input",block_id:`${id}__continuation`,label:plain("이어서 입력 (선택)"),optional:true,element:{type:"plain_text_input",action_id:`${id}__continuation`,multiline:true,max_length:max - 3000,...(initial.length > 3000 ? {initial_value:initial.slice(3000,max)} : {})}});
  }
  return {type:"modal",callback_id:`operator:${String(data.custom_id)}`,private_metadata:metadata(input),title:plain(String(data.title ?? "운영 입력").slice(0,24)),submit:plain("확인"),close:plain("취소"),blocks};
}
function resultContent(result: Result) {
  const data = object(result.data);
  const embeds = Array.isArray(data.embeds) ? data.embeds : [];
  const text = [typeof data.content === "string" ? data.content : "",...embeds.map(embed => String(object(embed).description ?? ""))].filter(Boolean).join("\n\n");
  return {data,text,options:{components:(Array.isArray(data.components) ? data.components : []) as MessageActionRow[]}};
}
export async function deliverResult(input: SlackIngress, result: Result): Promise<void> {
  if (result.type === InteractionResponseType.MODAL) {
    const opened = await slackApi("views.open",{trigger_id:input.triggerId,view:operatorView(input,result.data)});
    if (!opened.ok) await respondToUser(input,"입력창을 열지 못했습니다. 명령을 다시 실행하세요.");
    return;
  }
  if (result.type === InteractionResponseType.DEFERRED_UPDATE_MESSAGE) {
    if (/^command:e(confirm|cancel):/.test(input.interaction.data?.custom_id ?? "") && input.responseUrl) await respondSlack(input.responseUrl,{delete_original:true});
    return;
  }
  const {data,text,options} = resultContent(result);
  const contents = renderSlackMessages(text || "처리했습니다.",options);
  const ephemeral = (Number(data.flags ?? 0) & EPHEMERAL_FLAG) !== 0;
  if (result.type === InteractionResponseType.UPDATE_MESSAGE && input.context.messageId) {
    const edited = await editChannelMessage(input.context.channelId,input.context.messageId,text,options);
    if (!edited.ok) throw new Error("SLACK_RESULT_UPDATE_FAILED");
  } else if (input.responseUrl) {
    for(const [index,content] of contents.entries()) {
      if(index<5) {
        if(!await respondSlack(input.responseUrl,{...content,response_type:ephemeral ? "ephemeral" : "in_channel",...(contents.length>1 ? {replace_original:false} : {})}))throw new Error("SLACK_RESPONSE_FAILED");
      } else {
        const sent=await slackApi(ephemeral ? "chat.postEphemeral" : "chat.postMessage",{channel:input.context.channelId,...(ephemeral ? {user:input.context.userId} : {}),...content});
        if(!sent.ok)throw new Error("SLACK_RESPONSE_FAILED");
      }
    }
  } else if (ephemeral) {
    for(const content of contents) {
      const sent = await slackApi("chat.postEphemeral",{channel:input.context.channelId,user:input.context.userId,...content});
      if (!sent.ok) throw new Error("SLACK_EPHEMERAL_FAILED");
    }
  } else {
    const sent = await createChannelMessage(input.context.channelId,text,options);
    if (!sent.ok) throw new Error("SLACK_RESULT_DELIVERY_FAILED");
  }
}
async function respondToUser(input: SlackIngress, text: string) { await deliverResult(input,{type:4,data:{content:text,flags:EPHEMERAL_FLAG}}); }
async function claim(id: string): Promise<boolean> {
  try { await prisma.slackRequestReceipt.create({data:{id}}); return true; }
  catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false; throw error; }
}

export async function prepareSlackRequest(body: string, schedule: (work: () => Promise<void>) => void): Promise<Record<string,unknown> | null> {
  const input = normalizeSlackRequest(body,env.operatorRoles);
  if (!validateSlackScope(input,{workspaceId:env.slackWorkspaceId(),applicationId:env.slackAppId()})) throw new Error("SLACK_SCOPE_DENIED");
  const card = input.kind === "action" || input.interaction.data?.custom_id?.startsWith("papproval:") === true;
  if (!isOperatorScope({workspaceId:input.context.workspaceId,channelId:input.context.channelId,expectedWorkspaceId:env.slackWorkspaceId(),allowedChannelIds:interactionChannelKeys(card,input.interaction.data?.custom_id).map(env.notificationChannelId)})) throw new Error("SLACK_SCOPE_DENIED");
  if (input.kind === "options") {
    const result: Result = await handleOperatorInteraction(input.interaction);
    const choices = object(result.data).choices;
    return {options:Array.isArray(choices) ? choices.map(choice => ({text:plain(String(object(choice).name).slice(0,75)),value:String(object(choice).value)})) : []};
  }
  if (!await claim(input.interaction.id)) return null;
  if (input.kind === "submission") {
    try {
      const result: Result = await handleOperatorInteraction(input.interaction);
      if (result.type === InteractionResponseType.MODAL) return {response_action:"update",view:operatorView(input,result.data)};
      const {data,text} = resultContent(result);
      if ((Number(data.flags ?? 0) & EPHEMERAL_FLAG) && !/^[⏳🧹]|연결했습니다/.test(text) && input.fieldIds[0]) return {response_action:"errors",errors:{[input.fieldIds[0]]:text.slice(0,2000)}};
      schedule(async () => { await deliverResult(input,result).catch(() => console.error("[slack] 입력 결과 전송 실패",input.interaction.id)); });
      return {};
    } catch {
      return {response_action:"errors",errors:{[input.fieldIds[0] ?? "text"]:"처리하지 못했습니다. 입력을 보존했으니 권한과 최신 상태를 확인하고 다시 시도하세요."}};
    }
  }
  schedule(async () => {
    try {
      if (input.missing && input.definition) {
        if (!hasOperatorCapability(input.interaction.actor?.roles ?? [],input.definition.capability)) return await respondToUser(input,"이 명령을 실행할 역할 권한이 없습니다.");
        const opened = await slackApi("views.open",{trigger_id:input.triggerId,view:commandView(input)});
        if (!opened.ok) await respondToUser(input,"입력창을 열지 못했습니다. 명령을 다시 실행하세요.");
        return;
      }
      await deliverResult(input,await handleOperatorInteraction(input.interaction));
    } catch { await respondToUser(input,"요청 처리에 실패했습니다. 현재 상태를 확인하고 다시 시도하세요.").catch(() => {}); console.error("[slack] 요청 처리 실패",input.interaction.id); }
  });
  return null;
}
