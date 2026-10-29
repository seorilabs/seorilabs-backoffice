import { createHash } from "node:crypto";
import type { MessageOptions, SlackBlock } from "@/lib/notifications/channel";
import { presentationTime } from "./presentation";
import { markdownPlain, richBlocks, richPlain } from "./rich-text";

export interface SlackMessage { text:string; blocks:SlackBlock[]; unfurl_links:false; unfurl_media:false }
const plain = (text:string) => ({type:"plain_text",text,emoji:true});
const literal = (text:string, bold=false): SlackBlock => ({type:"rich_text",elements:[{type:"rich_text_section",elements:[{type:"text",text,...(bold ? {style:{bold:true}} : {})}]}]});
function blockPlain(block: SlackBlock): string {
  if(block.type === "divider")return "";
  if(block.type === "image")return String(block.alt_text ?? "");
  if(block.type === "actions")return "동작: " + (block.elements as {text:{text:string};url?:string}[]).map(e=>e.text.text+(e.url ? ` (${e.url})` : "")).join(", ");
  if(block.type === "rich_text")return (block.elements as Parameters<typeof richPlain>[0][]).map(richPlain).join("\n");
  if(block.type === "header")return (block.text as {text:string}).text;
  if(block.type === "context")return (block.elements as {text:string}[]).map(e=>e.text).join(" | ");
  return "";
}
export function renderSlackMessages(text:string, options:MessageOptions = {}): SlackMessage[] {
  const p=options.presentation;
  let body=p ? p.body ?? "" : text;
  let title=p?.title ?? (options.plain ? undefined : options.embed?.title);
  if(!title && !options.plain) {
    const first=body.split("\n")[0];
    if (/^(#{1,6} |\*\*.+\*\*$)/.test(first)) {title=markdownPlain(first);body=body.slice(first.length).trimStart();}
  }
  if(title && markdownPlain(body.split("\n")[0]).trim() === title.trim())body=body.includes("\n") ? body.slice(body.indexOf("\n")+1).trimStart() : "";
  const groups:SlackBlock[][]=[];
  const status=p?.status && ({success:"✅ 완료",warning:"⚠️ 확인 필요",failure:"❌ 실패",info:"ℹ️ 안내"})[p.status];
  if(status)groups.push([literal(status)]);
  if(p?.fields?.length) {
    const chars=Array.from(p.fields.map(f=>`${f.label}: ${f.value == null || f.value === "" ? "미제공" : typeof f.value === "number" ? f.value.toLocaleString("ko-KR") : f.value}`).join("\n"));
    for(let start=0;start<chars.length;start+=2400)groups.push([literal(chars.slice(start,start+2400).join(""))]);
  }
  if(body)groups.push(richBlocks(body));
  for(const section of p?.sections ?? [])groups.push([...(section.title ? [literal(section.title,true)] : []),...richBlocks(section.body)]);
  for(const [index,item] of (p?.items ?? []).entries()) groups.push([...(index ? [{type:"divider"}] : []),literal(item.title,true),...richBlocks(item.summary),{type:"rich_text",elements:[{type:"rich_text_section",elements:[{type:"link",url:item.url,text:"원문 보기"}]}]}]);
  if(p?.links?.length)groups.push([{type:"rich_text",elements:[{type:"rich_text_section",elements:p.links.flatMap((link,index)=>[...(index ? [{type:"text",text:"  "}] : []),{type:"link",url:link.url,text:link.label}])}]}]);
  const suffix:SlackBlock[]=[];
  if(options.receipt?.fileId && options.inlineImage)suffix.push({type:"image",slack_file:{id:options.receipt.fileId},alt_text:p?.title ?? title ?? options.attachment?.filename ?? "보고서 이미지"});
  const metadata=[...(p?.context ?? []),...(!p && options.embed?.footer ? [options.embed.footer] : []),presentationTime(p?.timestamp ?? options.embed?.timestamp)].filter((s):s is string=>!!s);
  for(const value of metadata) {
    // context는 Markdown을 해석하지 않아 내부 코드와 특수문자를 그대로 읽는다.
    const chars=Array.from(value);
    for(let start=0;start<chars.length;start+=1900)suffix.push({type:"context",elements:[plain(chars.slice(start,start+1900).join(""))]});
  }
  if(!p && options.embed?.url && /^https:\/\//.test(options.embed.url))suffix.push({type:"context",elements:[{type:"mrkdwn",text:`<${options.embed.url.replace(/&/g,"&amp;").replace(/>/g,"%3E").replace(/\|/g,"%7C")}|상세 보기>`}]});
  if(options.alertRoleId && /^(<@[UW][A-Z0-9]+>\s*)+$/.test(options.alertRoleId))suffix.push({type:"context",elements:[{type:"mrkdwn",text:options.alertRoleId}]});
  let primaryUsed=false;
  for(const row of options.components ?? []) {
    const buttons=row.components.filter(button=>!button.disabled).flatMap((button):SlackBlock[]=>{
      const label=plain(Array.from(button.label).slice(0,75).join(""));
      if(button.url && /^https:\/\//.test(button.url))return [{type:"button",text:label,url:button.url,action_id:`link:${createHash("sha256").update(button.url).digest("hex").slice(0,20)}`}];
      if(!button.custom_id)return [];
      const primary=!primaryUsed && (button.style===3 || button.style===1);
      if(primary)primaryUsed=true;
      return [{type:"button",text:label,action_id:button.custom_id,value:button.custom_id,...(button.style===4 ? {style:"danger"} : primary ? {style:"primary"} : {})}];
    });
    for(let start=0;start<buttons.length;start+=25)suffix.push({type:"actions",elements:buttons.slice(start,start+25)});
  }
  const pages:SlackBlock[][]=[]; let current:SlackBlock[]=[];let size=0;
  // 기사 단위로 배치한다. 한 기사 자체가 상한을 넘으면 블록 경계에서만 나눈다.
  for(const group of groups) {
    const groupSize=group.map(blockPlain).join("\n").length;
    if(current.length && (current.length+group.length>36 || size+groupSize>26000)){pages.push(current);current=[];size=0;}
    for(const block of group) {
      const length=blockPlain(block).length;
      if(current.length && (current.length>=36 || size+length>26000)){pages.push(current);current=[];size=0;}
      current.push(block);size+=length;
    }
  }
  if(current.length || !pages.length)pages.push(current);
  // 부가 요소도 개수 제한 전에 배치한다. 버튼과 첨부를 slice로 버리지 않는다.
  for(const block of suffix) {
    if(pages.at(-1)!.length>=46 || pages.at(-1)!.map(blockPlain).join("\n").length+blockPlain(block).length>28000)pages.push([]);
    pages.at(-1)!.push(block);
  }
  return pages.map((blocks,index)=>{
    const pageTitle=title ? `${title}${pages.length>1 ? ` (${index+1}/${pages.length})` : ""}` : pages.length>1 ? `이어서 (${index+1}/${pages.length})` : undefined;
    if(pageTitle)blocks=[...(pageTitle.length<=150 ? [{type:"header",text:plain(pageTitle)}] : richBlocks(`**${pageTitle.replace(/[\\*]/g,"\\$&")}**`)),...blocks];
    return {text:blocks.map(blockPlain).filter(Boolean).join("\n").replace(/</g,"&lt;").replace(/>/g,"&gt;").slice(0,40000),blocks,unfurl_links:false,unfurl_media:false};
  });
}
/** 단일 메시지 호출도 같은 표시 경계를 쓴다. 전송 경로는 전체 pages를 사용한다. */
export function renderSlackMessage(text:string, options:MessageOptions = {}): SlackMessage {
  const pages=renderSlackMessages(text,options);
  if(pages.length>1)throw new Error("SLACK_MULTIPART_RENDER_REQUIRED");
  return pages[0];
}
