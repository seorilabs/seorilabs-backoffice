import assert from "node:assert/strict";
import test from "node:test";
import { operationalInterestCard, operationalEventLine, parseOperationalEvent, type OperationalEventInput } from "./operational-events";
const event: OperationalEventInput = {version:1,eventId:"iap_context_123456",occurredAt:"2026-11-13T01:00:00Z",type:"iap.granted",appId:"demo",outcome:"granted",attributes:{platform:"google_play",entitlementId:"sp_veiled_chameleon",platformUserId:"pu_01ARZ3NDEKTSV4RRFFQ69G5FAV",countryCode:"US",countrySource:"google_play.regionCode",isTestPurchase:false}};
test("결제 검증 국가와 원장 ID를 수신하고 실제·테스트·미확인을 구분한다",()=>{
 assert.ok(parseOperationalEvent(event));
 for (const [flag,label] of [[false,"실제 주문"],[true,"테스트 주문"],[undefined,"구분 미확인"]] as const){
  const attributes={...event.attributes}; if(flag===undefined)delete attributes.isTestPurchase;else attributes.isTestPurchase=flag;
  const card=operationalInterestCard({...event,attributes},"예제 앱");
  assert.match(card.presentation!.title,new RegExp(`구글플레이.*${label}.*예제 앱`));
  assert.match(card.text,/사용자 ID: pu_/);assert.match(card.text,/결제 국가:/);
 }
});
test("복원·소유권 이전은 신규 결제로 표시하지 않는다",()=>{
 for(const [grantKind,label] of [["restore","복원"],["transfer","소유권 이전"]]){
  const card=operationalInterestCard({...event,attributes:{...event.attributes,grantKind}},"앱");
  assert.match(card.presentation!.title,new RegExp(label));assert.doesNotMatch(card.presentation!.title,/결제 발생/);
 }
});
test("국가 없는 예전 이벤트와 Android·iOS 보상은 추정 없이 표시한다",()=>{
 for(const clientPlatform of ["android","ios",undefined]){
  const attributes={provider:"admob",rewardKey:"crystal",rewardAmount:0,...(clientPlatform?{clientPlatform}:{})};
  const reward={...event,type:"ad.reward.delivered" as const,attributes};
  assert.ok(parseOperationalEvent(reward));const card=operationalInterestCard(reward,"앱");
  assert.match(card.text,/crystal: 0/);assert.doesNotMatch(card.text,/국가/);
  assert.match(card.presentation!.title,new RegExp(clientPlatform==="ios"?"iOS":clientPlatform?"Android":"플랫폼 미확인"));
 }
 const line=operationalEventLine({...event,type:"identity.created",attributes:{countryCode:"KR",countrySource:"event.source"}},"앱");assert.match(line,/국가: KR/);
});
test("국가·플랫폼·운영 ID의 잘못된 값을 거부한다",()=>{
 for(const attributes of [{countryCode:"한국"},{countrySource:"email@bad"},{clientPlatform:"windows"},{platformUserId:"email@example.com"}]){
  assert.equal(parseOperationalEvent({...event,type:"ad.reward.delivered",attributes}),null);
 }
});
