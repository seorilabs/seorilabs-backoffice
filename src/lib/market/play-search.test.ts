import assert from "node:assert/strict";
import {test} from "node:test";
import {playPublicName} from "./play-search";
const detail=(id:string,name:string)=>`<html><body><script>var id="${id}"</script><script type="application/ld+json">${JSON.stringify({'@type':'SoftwareApplication',name,url:`https://play.google.com/store/apps/details/App?id=${id}&hl=en`})}</script></body></html>`;
test('Play 브랜드 판정에는 확인된 앱의 공개 이름을 사용한다',()=>{
 assert.equal(playPublicName(detail('com.example.app','BabyNest: Shared Baby Care Log'),'com.example.app'),'BabyNest: Shared Baby Care Log');
 assert.equal(playPublicName(detail('com.other.app','Other'),'com.example.app'),undefined);
 assert.equal(playPublicName('<html><body></body></html>','com.example.app'),undefined);
 assert.throws(()=>playPublicName(detail('com.example.app','A').slice(0,-10),'com.example.app'),/TRUNCATED/);
 assert.throws(()=>playPublicName('<html><body>recaptcha</body></html>','com.example.app'),/BLOCKED/);
});
test('Play 공개 이름은 요청한 앱의 구조화 데이터에서만 읽는다',()=>{
 const own=detail('com.example.app','Own');
 const other=detail('com.other.app','Other').match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/)![0];
 assert.equal(playPublicName(own.replace('<body>',`<body>${other}`),'com.example.app'),'Own');
 assert.equal(playPublicName(own.replace('<body>','<body><script type="application/ld+json">{invalid</script>'),'com.example.app'),'Own');
 assert.equal(playPublicName(own.replace('https://play.google.com/store/apps/details/App','https://other.example/store/apps/details/App'),'com.example.app'),undefined);
 assert.equal(playPublicName(own.replace('&hl=en','x&hl=en'),'com.example.app'),undefined);
 assert.equal(playPublicName(own.replace(/,"url":"[^"]+"/,''),'com.example.app'),undefined);
});
