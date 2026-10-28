import assert from "node:assert/strict";
import {test} from "node:test";
import {expandedKeywordPayload} from "./keyword-expansion";
const payload={schemaVersion:1,markets:[],monitoring:{enabled:true,keywords:['기존','Brand'],countries:['kr'],competitorAppIds:[],officialFeeds:[],checkSupportLinks:false}};
test('AC-6 공개 확인과 초안 충돌을 먼저 검사하고 기존 국가와 검색어를 보존한다',()=>{
 const input={payload,activeRevision:4,latestRevision:4,publicConfirmed:true,terms:['brand','새 검색어',...Array.from({length:40},(_,i)=>`term${i}`)]};
 const result=expandedKeywordPayload(input);assert.equal(result.status,'ready');
 if(result.status==='ready'){assert.deepEqual(result.payload.monitoring?.countries,['kr']);assert.deepEqual(result.payload.monitoring?.keywords.slice(0,3),['기존','Brand','새 검색어']);assert.equal(result.payload.monitoring?.keywords.length,30);assert.equal(result.payload.monitoring?.checkSupportLinks,false);}
 assert.deepEqual(payload.monitoring.keywords,['기존','Brand']);
 assert.equal(expandedKeywordPayload({...input,latestRevision:5}).status,'needs_input');
 assert.equal(expandedKeywordPayload({...input,publicConfirmed:false}).status,'public_unconfirmed');
});
