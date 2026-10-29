import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { notificationChannelId } from "./destinations";
import type { MessagePresentation } from "@/lib/slack/presentation";
import { renderSlackMessages } from "@/lib/slack/message";
export { renderSlackMessage, renderSlackMessages } from "@/lib/slack/message";
import { slackApi, type SlackResult } from "@/lib/slack/api";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export type DeliveryResult = SlackResult;
// 숫자 태그와 custom_id는 이미 저장된 카드 payload의 내부 계약이다. Slack wire 형식은 아래 경계에서 만든다.
export interface MessageButton { type: 2; style: 1 | 2 | 3 | 4 | 5; label: string; custom_id?: string; url?: string; disabled?: boolean }
export interface MessageActionRow { type: 1; components: MessageButton[] }
export interface MessageAttachment { filename: string; contentType: string; base64: string }
export interface MessageEmbed { title?: string; color?: number; url?: string; footer?: string; timestamp?: string }
export interface FileReceipt { checksum: string; fileId: string; uploaded: boolean; complete: boolean; messageTs?: string; fileIds: string[] }
export interface MessagePageReceipt { state: "STARTED" | "CONFIRMED"; messageId?: string }
export interface MessageOptions {
  pages?: MessagePageReceipt[]; persistPages?: (pages: MessagePageReceipt[]) => Promise<void>;
  alertRoleId?: string; components?: MessageActionRow[]; attachment?: MessageAttachment; inlineImage?: boolean;
  presentation?: MessagePresentation;
  plain?: boolean; embed?: MessageEmbed; replyToMessageId?: string; botToken?: string;
  receipt?: FileReceipt; persistReceipt?: (receipt: FileReceipt) => Promise<void>;
  beforeCreate?: () => Promise<boolean>; created?: (result: DeliveryResult) => Promise<void>;
}
export type SlackBlock = Record<string, unknown>;

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function slackText(value: string): string {
  const links: string[] = [];
  const text = value.replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => {
    links.push(`<${escape(url).replace(/\|/g,"%7C")}|${escape(label).replace(/\|/g," ")}>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  return escape(text).replace(/\*\*([^*]+)\*\*/g,"*$1*").replace(/~~([^~]+)~~/g,"~$1~").replace(/\u0001(\d+)\u0001/g, (_, index: string) => links[Number(index)] ?? "");
}
export function splitMessageText(text: string): string[] {
  let rest = text.trim();
  const chunks: string[] = [];
  while (rest.length > 2800) {
    let end = rest.lastIndexOf("\n",2800);
    if (end < 1400) end = 2800;
    chunks.push(rest.slice(0,end)); rest = rest.slice(end).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {}; }
export function fileReceipt(value: unknown): FileReceipt | undefined {
  const item = object(value);
  if (typeof item.fileId !== "string" || typeof item.checksum !== "string" || !Array.isArray(item.fileIds)) return;
  return { checksum:item.checksum,fileId:item.fileId,uploaded:item.uploaded === true,complete:item.complete === true,fileIds:item.fileIds.filter((id): id is string => typeof id === "string"),...(typeof item.messageTs === "string" ? {messageTs:item.messageTs} : {}) };
}
async function uploadAttachment(channel: string, text: string, options: MessageOptions, existingMessage?: string): Promise<SlackResult & { receipt?: FileReceipt }> {
  const attachment = options.attachment!;
  const bytes = Buffer.from(attachment.base64,"base64");
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) return {ok:false,error:"SLACK_ATTACHMENT_SIZE_INVALID",terminal:true};
  const checksum = createHash("sha256").update(bytes).digest("hex");
  let receipt = options.receipt;
  if (!receipt || receipt.checksum !== checksum) {
    const started = await slackApi("files.getUploadURLExternal",{filename:attachment.filename,length:bytes.length},{token:options.botToken});
    if (!started.ok) return started;
    const fileId = started.data?.file_id;
    const uploadUrl = started.data?.upload_url;
    if (typeof fileId !== "string" || typeof uploadUrl !== "string" || !uploadUrl.startsWith("https://files.slack.com/upload/")) return {ok:false,error:"SLACK_UPLOAD_RESPONSE_INVALID",terminal:true};
    receipt = {checksum,fileId,uploaded:false,complete:false,fileIds:[...(receipt?.fileIds ?? []),fileId]};
    await options.persistReceipt?.(receipt);
    try {
      const uploaded = await fetch(uploadUrl,{method:"POST",body:bytes,headers:{"Content-Type":"application/octet-stream"},signal:AbortSignal.timeout(20000),redirect:"error"});
      if (!uploaded.ok) return {ok:false,error:"SLACK_DELIVERY_OUTCOME_UNKNOWN",terminal:true};
    } catch { return {ok:false,error:"SLACK_DELIVERY_OUTCOME_UNKNOWN",terminal:true}; }
    receipt.uploaded = true;
    await options.persistReceipt?.(receipt);
  }
  if (!receipt.uploaded) return {ok:false,error:"SLACK_DELIVERY_OUTCOME_UNKNOWN",terminal:true};
  if (!receipt.complete) {
    if (options.beforeCreate && !await options.beforeCreate()) return {ok:false,error:"SLACK_DELIVERY_OUTCOME_UNKNOWN",terminal:true};
    const completed = await slackApi("files.completeUploadExternal",{files:[{id:receipt.fileId,title:attachment.filename}],channel_id:channel,initial_comment:existingMessage ? "보고서 첨부 갱신" : slackText(text).slice(0,4000),...(existingMessage || options.replyToMessageId ? {thread_ts:existingMessage ?? options.replyToMessageId} : {})},{token:options.botToken});
    if (!completed.ok) { await options.created?.(completed); return completed; }
    receipt.complete = true;
    await options.persistReceipt?.(receipt);
  }
  if (!receipt.messageTs) {
    const info = await slackApi("files.info",{file:receipt.fileId},{token:options.botToken});
    if (!info.ok) return info;
    const shares = object(object(info.data?.file).shares);
    const records = object(shares.public)[channel] ?? object(shares.private)[channel];
    const ts = Array.isArray(records) ? object(records[0]).ts : undefined;
    if (typeof ts !== "string") return {ok:false,error:"SLACK_FILE_MESSAGE_PENDING",retryAfterMs:5000};
    receipt.messageTs = ts;
    await options.persistReceipt?.(receipt);
  }
  await options.created?.({ok:true,messageId:receipt.messageTs});
  return {ok:true,messageId:existingMessage ?? receipt.messageTs,receipt};
}
/** 연속편은 providerReceipt에 시도를 먼저 기록하고 결과 불명 요청을 재전송하지 않는다. */
export function messagePageReceipts(value: unknown): MessagePageReceipt[] {
  if(!Array.isArray(value))return [];
  return value.flatMap(item => {
    const page=object(item);
    return page.state === "STARTED" || page.state === "CONFIRMED" ? [{state:page.state,...(typeof page.messageId === "string" ? {messageId:page.messageId} : {})} as MessagePageReceipt] : [];
  });
}
async function continuationPages(channel:string, rootId:string, messages:ReturnType<typeof renderSlackMessages>, options:MessageOptions):Promise<DeliveryResult> {
  const receipts=[...(options.pages ?? [])];
  const save=async()=>{await options.persistPages?.(structuredClone(receipts));};
  for(let index=1;index<messages.length;index++) {
    const current=receipts[index-1];
    if(current?.state === "STARTED")return {ok:false,error:"SLACK_DELIVERY_OUTCOME_UNKNOWN",terminal:true};
    let result:DeliveryResult;
    if(current?.messageId) {
      result=await slackApi("chat.update",{channel,ts:current.messageId,...messages[index]},{token:options.botToken});
      if(!result.ok)return result;
      continue;
    }
    receipts[index-1]={state:"STARTED"};await save();
    result=await slackApi("chat.postMessage",{channel,...messages[index],...(options.replyToMessageId ? {thread_ts:options.replyToMessageId} : {})},{token:options.botToken});
    if(result.ok && !result.messageId)result={ok:false,error:"SLACK_DELIVERY_OUTCOME_UNKNOWN",terminal:true};
    if(!result.ok) {
      if(result.error !== "SLACK_DELIVERY_OUTCOME_UNKNOWN"){receipts.splice(index-1,1);await save();}
      return result;
    }
    receipts[index-1]={state:"CONFIRMED",messageId:result.messageId};await save();
  }
  // 내용 갱신으로 짧아진 경우 같은 전송의 남은 연속편만 지운다.
  while(receipts.length>messages.length-1) {
    const page=receipts.at(-1)!;
    if(page.state === "STARTED")return {ok:false,error:"SLACK_DELIVERY_OUTCOME_UNKNOWN",terminal:true};
    if(page.messageId){const deleted=await deleteChannelMessage(channel,page.messageId,options.botToken);if(!deleted.ok && deleted.error !== "message_not_found")return deleted;}
    receipts.pop();await save();
  }
  return {ok:true,messageId:rootId};
}
export async function createChannelMessage(channel: string, text: string, options: MessageOptions = {}): Promise<DeliveryResult> {
  if (!/^[CG][A-Z0-9]+$/.test(channel)) return {ok:false,error:"SLACK_CHANNEL_NOT_CONFIGURED",terminal:true};
  if (options.attachment) {
    const file = await uploadAttachment(channel,text,options);
    if (!file.ok || !file.messageId) return file;
    return editChannelMessage(channel,file.messageId,text,{...options,attachment:undefined,receipt:file.receipt});
  }
  const messages=renderSlackMessages(text,options);
  if (options.beforeCreate && !await options.beforeCreate()) return {ok:false,error:"SLACK_DELIVERY_OUTCOME_UNKNOWN",terminal:true};
  let result = await slackApi("chat.postMessage",{channel,...messages[0],...(options.replyToMessageId ? {thread_ts:options.replyToMessageId} : {})},{token:options.botToken});
  if (result.ok && !result.messageId) result = {ok:false,error:"SLACK_DELIVERY_OUTCOME_UNKNOWN",terminal:true};
  await options.created?.(result);
  if(!result.ok || !result.messageId)return result;
  return continuationPages(channel,result.messageId,messages,options);
}
export async function editChannelMessage(channel: string, messageId: string, text: string, options: MessageOptions = {}): Promise<DeliveryResult> {
  if (!/^\d+\.\d+$/.test(messageId)) return {ok:false,error:"SLACK_MESSAGE_ID_INVALID",terminal:true};
  let receipt = options.receipt;
  if (options.attachment) {
    const current = await slackApi("chat.update",{channel,ts:messageId,...renderSlackMessages(text,options)[0],...(options.inlineImage && receipt?.fileId ? {file_ids:[]} : {})},{token:options.botToken});
    if (!current.ok) return current;
    const file = await uploadAttachment(channel,text,options,messageId);
    if (!file.ok) return file;
    receipt = file.receipt;
  }
  const messages=renderSlackMessages(text,{...options,receipt});
  const result=await slackApi("chat.update",{channel,ts:messageId,...messages[0],...(options.inlineImage && receipt?.fileId ? {file_ids:[]} : {})},{token:options.botToken});
  if(!result.ok)return result;
  // 기본 파일 미리보기는 원본에서 비우고 마지막 페이지에 이미지를 표시한다.
  return continuationPages(channel,messageId,messages,options);
}
export function deletedMessageReplacement(options: MessageOptions): MessageOptions {
  // 삭제가 확인된 메시지의 공유 영수증은 새 게시에 재사용하지 않는다. 이전 파일 ID는 보존 정리에 남긴다.
  return options.receipt ? {...options,receipt:{...options.receipt,checksum:"",messageTs:undefined}} : options;
}
export async function sendNotification(destination: string, text: string, options: MessageOptions = {}) { return createChannelMessage(notificationChannelId(destination),text,options); }
export async function editNotification(destination: string, messageId: string, text: string, options: MessageOptions = {}) { return editChannelMessage(notificationChannelId(destination),messageId,text,options); }
export async function deleteChannelMessage(channel: string, messageId: string, botToken?: string) { return slackApi("chat.delete",{channel,ts:messageId},{token:botToken}); }
export async function deleteNotification(destination: string, messageId: string, botToken?: string) { return deleteChannelMessage(notificationChannelId(destination),messageId,botToken); }
export async function currentOperatorRoles(userId: string, request: typeof fetch = fetch): Promise<string[]> {
  const result = await slackApi("users.info",{user:userId},{request,timeoutMs:2000});
  const user = object(result.data?.user);
  if (!result.ok || user.deleted === true || user.is_bot === true || user.team_id !== env.slackWorkspaceId()) throw new Error("현재 Slack 사용자를 확인할 수 없습니다.");
  return env.operatorRoles(userId);
}
