import assert from "node:assert/strict";
import test from "node:test";
import { handleReleaseNotification, releaseNotificationPayload, releaseNotificationSchema } from "./release-notifications";
const raw={id:"demo-v1.2.3-testflight-12",app:"예제 앱",tag:"v1.2.3",status:"TestFlight 내부 배포 완료",fields:[{label:"빌드 번호",value:"12"}],links:[{label:"TestFlight",url:"https://testflight.apple.com/join/example"}],note:"저장 흐름 확인",test:true};
test("출시 알림은 운영 인증 뒤 검증하며 접수와 전달을 구분한다",async()=>{
 let calls=0;const save=async()=>{calls++;return {accepted:true,eventId:"e1",duplicate:false,delivered:false,deliveries:[]};};
 assert.equal((await handleReleaseNotification(null,"token",async()=>JSON.stringify(raw),save)).status,401);assert.equal(calls,0);
 const result=await handleReleaseNotification("token","token",async()=>JSON.stringify(raw),save);assert.equal(result.status,202);assert.equal((result.body as {delivered:boolean}).delivered,false);
 const duplicate=await handleReleaseNotification("token","token",async()=>JSON.stringify(raw),async()=>({...await save(),duplicate:true}));assert.equal(duplicate.status,200);
 assert.equal((await handleReleaseNotification("token","token",async()=>JSON.stringify(raw),async()=>{throw Error("RELEASE_NOTIFICATION_CONFLICT");})).status,409);
});
test("출시 알림은 링크와 빌드·상태·확인 요청을 보존하고 발송 ID의 내용 변경을 구분한다",()=>{
 const parsed=releaseNotificationSchema.parse(raw);const payload=releaseNotificationPayload(parsed);assert.match(payload.text,/\[테스트\].*예제 앱/);assert.match(payload.text,/빌드 번호: 12/);assert.match(payload.text,/확인 요청: 저장 흐름 확인/);
 assert.notEqual(payload.releaseNotificationHash,releaseNotificationPayload({...parsed,status:"처리 중"}).releaseNotificationHash);
 for(const url of ["http://example.com","javascript:alert(1)"])assert.equal(releaseNotificationSchema.safeParse({...raw,links:[{label:"링크",url}]}).success,false);
});
