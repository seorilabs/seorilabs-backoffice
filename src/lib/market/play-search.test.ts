import assert from "node:assert/strict";
import {test} from "node:test";
import {playPublicName} from "./play-search";
const detail=(id:string,name:string)=>`<html><body><script>var id="${id}"</script><script type="application/ld+json">${JSON.stringify({'@type':'SoftwareApplication',name})}</script></body></html>`;
test('Play 브랜드 판정에는 확인된 앱의 공개 이름을 사용한다',()=>{
 assert.equal(playPublicName(detail('com.example.app','BabyNest: Shared Baby Care Log'),'com.example.app'),'BabyNest: Shared Baby Care Log');
 assert.equal(playPublicName(detail('com.other.app','Other'),'com.example.app'),undefined);
 assert.equal(playPublicName('<html><body></body></html>','com.example.app'),undefined);
 assert.throws(()=>playPublicName(detail('com.example.app','A').slice(0,-10),'com.example.app'),/TRUNCATED/);
 assert.throws(()=>playPublicName('<html><body>recaptcha</body></html>','com.example.app'),/BLOCKED/);
});
