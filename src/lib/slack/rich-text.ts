import { Lexer, type Token, type Tokens } from "marked";

export type RichInline = {type:"text";text:string;style?:Record<string,boolean>} | {type:"link";url:string;text?:string;style?:Record<string,boolean>};
export interface RichElement { type: string; elements: RichInline[] | RichElement[]; style?: string; indent?: number; offset?: number }
export interface RichBlock extends Record<string, unknown> { type: "rich_text"; elements: RichElement[] }
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27|nbsp);/g, entity => ({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&apos;":"'","&#39;":"'","&#x27;":"'","&nbsp;":" "})[entity]!);
const safeUrl = (value: string) => /^https?:\/\//i.test(value) && (() => {try {return !!new URL(value).hostname;} catch {return false;}})();

function inline(tokens: Token[], style: Record<string, boolean> = {}): RichInline[] {
  return tokens.flatMap((token): RichInline[] => {
    if (token.type === "strong" || token.type === "em" || token.type === "del") return inline(token.tokens ?? [], {...style,[{strong:"bold",em:"italic",del:"strike"}[token.type]]:true});
    if (token.type === "link") return safeUrl(token.href) ? [{type:"link",url:token.href,text:token.text === token.href ? new URL(token.href).hostname : inline(token.tokens ?? []).map(inlinePlain).join(""),...(Object.keys(style).length ? {style} : {})}] : inline(token.tokens ?? [],style);
    if (token.type === "codespan") return [{type:"text",text:decode(token.text),style:{...style,code:true}}];
    if (token.type === "br") return [{type:"text",text:"\n"}];
    if (token.type === "image") return [{type:"text",text:decode(token.text)}];
    if (token.type === "escape" || token.type === "text" || token.type === "html") {
      if (token.type === "text" && token.tokens) return inline(token.tokens,style);
      // HTML와 Slack 멘션은 텍스트로 남긴다. user/broadcast 요소를 만들지 않는다.
      return [{type:"text",text:decode(token.text),...(Object.keys(style).length ? {style} : {})}];
    }
    return [{type:"text",text:token.raw,...(Object.keys(style).length ? {style} : {})}];
  }).filter(element => element.type !== "text" || element.text.length > 0);
}
const section = (elements: RichInline[]): RichElement => ({type:"rich_text_section",elements:elements.length ? elements : [{type:"text",text:" "}]});
function elements(tokens: Token[], indent = 0): RichElement[] {
  return tokens.flatMap((token): RichElement[] => {
    switch(token.type) {
      case "space": return [];
      case "heading": return [section(inline(token.tokens ?? [],{bold:true}))];
      case "paragraph": case "text": return [section(inline(token.tokens ?? Lexer.lexInline(token.text)))];
      case "code": return [{type:"rich_text_preformatted",elements:[{type:"text",text:token.text || " "}]}];
      case "blockquote": return [{type:"rich_text_quote",elements:elements(token.tokens ?? []).flatMap(item => flattenInline(item))}];
      case "list": return (token as Tokens.List).items.flatMap((item,index) => {
        const nested = item.tokens.filter(t=>t.type === "list");
        const body = item.tokens.filter(t=>t.type !== "list");
        return [{type:"rich_text_list",style:token.ordered ? "ordered" : "bullet",indent:Math.min(indent,8),...(token.ordered ? {offset:Number(token.start) + index - 1} : {}),elements:[section([...(item.task ? [{type:"text" as const,text:item.checked ? "☑ " : "☐ "}] : []),...elements(body).flatMap(flattenInline)])]},...elements(nested,indent+1)];
      });
      case "table": return [section(inline((token as Tokens.Table).header.flatMap((cell,index)=>[...cell.tokens,{type:"text",raw:"",text:index===(token as Tokens.Table).header.length-1 ? "\n" : " | "}]))),...(token as Tokens.Table).rows.map(row=>section(row.flatMap((cell,index)=>[...inline(cell.tokens),{type:"text" as const,text:index===row.length-1 ? "" : " | "}])))];
      case "hr": return [section([{type:"text",text:"────"}])];
      default: return [section(inline(Lexer.lexInline(token.raw)))];
    }
  });
}
function flattenInline(element: RichElement): RichInline[] {
  return element.elements.flatMap(child => child.type === "text" || child.type === "link" ? [child as RichInline] : flattenInline(child as RichElement));
}
export function markdownElements(markdown: string): RichElement[] {
  // Marked의 자동 링크가 <!channel>처럼 보이는 값을 Slack 요소로 바꾸지 않게 한다.
  return elements(Lexer.lex(markdown,{gfm:true}));
}
export function inlinePlain(element: RichInline): string {
  return element.type === "link" ? `${element.text ?? element.url}${element.text && element.text !== element.url ? ` (${element.url})` : ""}` : element.text;
}
export function richPlain(element: RichElement): string {
  if (element.type === "rich_text_list") return element.elements.map(child => `${element.style === "ordered" ? `${(element.offset ?? 0)+1}.` : "•"} ${richPlain(child as RichElement)}`).join("\n");
  return element.elements.map(child => child.type === "text" || child.type === "link" ? inlinePlain(child as RichInline) : richPlain(child as RichElement)).join("");
}
export function markdownPlain(markdown: string): string { return markdownElements(markdown).map(richPlain).join("\n"); }

/** 한 요소 자체가 길 때만 나눈다. 스타일, 링크와 목록의 순서를 유지한다. */
function splitElement(element: RichElement): RichElement[] {
  if (element.type === "rich_text_list") return element.elements.flatMap(child => splitElement(child as RichElement).map(part=>({...element,elements:[part]})));
  const pieces: RichElement[]=[]; let children: RichInline[]=[]; let size=0;
  for(const child of element.elements as RichInline[]) {
    const text=child.type === "text" ? child.text : child.text ?? child.url;
    // URL 자체는 분할할 수 없고 표시 문자열만 분할한다.
    const parts=Array.from(text);
    for(let start=0;start<parts.length;start+=2000) {
      const value=parts.slice(start,start+2000).join("");
      if(size + value.length > 2600 && children.length) {pieces.push({...element,elements:children});children=[];size=0;}
      children.push(child.type === "text" ? {...child,text:value} : {...child,text:value}); size+=value.length;
    }
  }
  if(children.length)pieces.push({...element,elements:children});
  return pieces;
}
export function richBlocks(markdown: string): RichBlock[] {
  const blocks: RichBlock[]=[]; let current: RichElement[]=[]; let size=0;
  for(const element of markdownElements(markdown).flatMap(splitElement)) {
    const length=JSON.stringify(element).length;
    if(current.length && (size+length>9000 || current.length>=35)){blocks.push({type:"rich_text",elements:current});current=[];size=0;}
    current.push(element);size+=length;
  }
  if(current.length)blocks.push({type:"rich_text",elements:current});
  return blocks;
}
