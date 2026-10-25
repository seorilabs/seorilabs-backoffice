"use client";
import {useEffect,useState,useTransition} from "react";
import {enqueuePlatformOperationAction,getPlatformOperationStatusAction,retryUnknownPlatformOperationAction,type PlatformOperationStatusResponse} from "@/lib/actions/platform-ops";
import {listPlatformRecoveryReferences,savePlatformRecoveryReference,removePlatformRecoveryReference,type PlatformRecoveryReference} from "@/lib/platform/recovery";

export function PlatformInboxConsole({enabled}:{enabled:boolean}) {
 const [reference,setReference]=useState<PlatformRecoveryReference|null>(null);
 const [loaded,setLoaded]=useState(false);
 const [puid,setPuid]=useState("");
 const [title,setTitle]=useState("테스트 선물");
 const [body,setBody]=useState("게임의 우편함에서 보상을 수령해 주세요.");
 const [product,setProduct]=useState<"starter_test_ticket_1"|"starter_badge">("starter_test_ticket_1");
 const [confirmation,setConfirmation]=useState("");
 const [message,setMessage]=useState("");
 const [result,setResult]=useState<PlatformOperationStatusResponse|null>(null);
 const [pending,startTransition]=useTransition();
 const expected=`ISSUE INBOX starter-game ${puid}`;
 useEffect(()=>{
  try {setReference(listPlatformRecoveryReferences(window.localStorage).find(x=>x.operation==="platform.inbox.issue")??null);setLoaded(true);}
  catch {setMessage("복구 참조를 보관할 수 없어 발송을 중지했습니다.");}
 },[]);
 function checkStatus() {
  if(!reference)return;
  startTransition(async()=>{
   try {const status=await getPlatformOperationStatusAction(reference.appSlug,reference.requestId);setResult(status);setMessage(status.error??status.result?.summary??status.status??"상태 미확인");}
   catch {setMessage("상태를 확인하지 못했습니다. 같은 요청을 유지합니다.");}
  });
 }
 function submit() {
  if((reference&&!missing)||!loaded||!enabled||confirmation!==expected)return;
  const next:PlatformRecoveryReference=reference??{appSlug:"starter-game",requestId:crypto.randomUUID(),operation:"platform.inbox.issue"};
  try {savePlatformRecoveryReference(window.localStorage,next);} catch {setMessage("복구 참조 저장에 실패해 발송하지 않았습니다.");return;}
  setReference(next);setResult(null);
  startTransition(async()=>{
   try {
    const queued=await enqueuePlatformOperationAction({operation:"platform.inbox.issue",requestId:next.requestId,appSlug:"starter-game",platformUserId:puid,title,body,entitlementId:product,reason:"internal_validation",serverConfirmation:confirmation});
    setMessage(queued.ok?"발송을 접수했습니다. 처리 상태를 확인해 주세요.":queued.error??"결과 미확인. 요청 ID로 상태를 확인해 주세요.");
   } catch {setMessage("접수 응답을 받지 못했습니다. 요청 ID로 상태를 확인해 주세요.");}
  });
 }
 const missing=!!result?.ok&&!result.found;
 const terminal=!!result?.ok&&!!result.found&&!result.outcomeUnknown&&["success","error","failure","cancelled","SUCCESS","FAILURE","CANCELLED"].includes(result.conclusion??result.result?.status??"");
 const field="mt-1 block w-full rounded border border-neutral-300 p-2 text-sm";
 return <section className="max-w-3xl space-y-4">
  <p className="text-sm text-neutral-600">Starter 내부 테스트 계정으로 서버 우편을 발송합니다. 앱의 UID 또는 지원 코드로 인증 화면에서 플랫폼 사용자 ID를 먼저 확인하세요. 보상은 선택한 상품 1개이며 우편은 만료되지 않습니다.</p>
  {!enabled&&<p role="status">현재 계정의 Starter 변경 권한이나 앱 등록 상태를 확인하지 못했습니다.</p>}
  <fieldset disabled={!enabled||pending||(!!reference&&!missing)} className="space-y-3 disabled:opacity-60">
   <label className="block text-sm">플랫폼 사용자 ID<input className={field} value={puid} onChange={e=>setPuid(e.target.value.trim())} maxLength={29}/></label>
   <label className="block text-sm">우편 제목<input className={field} value={title} onChange={e=>setTitle(e.target.value)} maxLength={120}/></label>
   <label className="block text-sm">우편 본문<textarea className={field} value={body} onChange={e=>setBody(e.target.value)} maxLength={4000} rows={3}/></label>
   <label className="block text-sm">보상 1개<select className={field} value={product} onChange={e=>setProduct(e.target.value as typeof product)}><option value="starter_test_ticket_1">테스트 티켓 1장</option><option value="starter_badge">스타터 배지</option></select></label>
   <label className="block text-sm">대상 확인 문구 <code className="break-all">{expected}</code><input className={field} value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>
   <button type="button" onClick={submit} disabled={!loaded||confirmation!==expected||!/^pu_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(puid)||!title.trim()||!body} className="rounded bg-neutral-900 px-4 py-3 text-white disabled:opacity-50">서버 우편 발송</button>
  </fieldset>
  {reference&&<div className="space-y-2 rounded border p-3"><p className="break-all text-sm">요청 ID: {reference.requestId}</p>
   <button type="button" onClick={checkStatus} disabled={pending} className="rounded border px-4 py-2">처리 상태 확인</button>
   {result?.outcomeUnknown&&!result.outcomeExpired&&<button type="button" disabled={pending} onClick={()=>startTransition(async()=>{try {const r=await retryUnknownPlatformOperationAction(reference.appSlug,reference.requestId);setMessage(r.ok?"같은 요청 ID로 처리를 다시 확인합니다.":r.error??"재시도 실패");}catch {setMessage("재시도 응답을 확인하지 못했습니다.");}})} className="ml-2 rounded border px-4 py-2">동일 요청 다시 확인</button>}
   {missing&&<p className="text-sm">접수된 요청이 아직 없습니다. 입력을 확인하고 같은 요청 ID로 다시 접수할 수 있습니다.</p>}
   {terminal&&<button type="button" disabled={pending} onClick={()=>{removePlatformRecoveryReference(window.localStorage,reference.requestId);setReference(null);setResult(null);setConfirmation("");}} className="ml-2 rounded border px-4 py-2">다음 우편 준비</button>}
  </div>}
  <p role="status" className="text-sm">{message}</p>
 </section>;
}
