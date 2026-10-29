import test from "node:test";
import assert from "node:assert/strict";
import { htmlToMessage,messageRender } from "./format";
test("기존 보고 HTML은 본문 의미를 유지한다",()=>{assert.equal(htmlToMessage('<b>지표</b> <code>v1</code> <a href="https://example.com">보기</a> &amp; 확인'),"**지표** `v1` [보기](https://example.com) & 확인");});
test("저장된 보고 payload는 본문과 표시 메타를 분리한다",()=>{
 assert.deepEqual(messageRender("OPS_ALERT",{text:"한 줄",plain:true}),{text:"한 줄",plain:true});
 assert.deepEqual(messageRender("OPS_ALERT",{text:"리포트",embed:{title:"제목",color:0x2FA55C,footer:"기간"}}),{text:"리포트",embed:{title:"제목",color:0x2FA55C,footer:"기간"}});
 assert.equal(messageRender("DEPLOY_COMPLETION",{text:"카드"}),null);assert.equal(messageRender("OPS_ALERT",null),null);
 assert.deepEqual(messageRender("OPS_ALERT",{text:"본문",embed:{color:-1,url:"javascript:x"}}),{text:"본문"});
});
