import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

test("검색 결과 캐시는 패키지명만 보관하고 큰 HTML 원문을 붙잡지 않는다", () => {
 const script = `
 import {parsePlaySearch} from ${JSON.stringify(pathToFileURL(resolve("src/lib/market/keyword-cycle.ts")).href)};
 const cached=[];
 global.gc();const start=process.memoryUsage().heapUsed;
 for(let i=0;i<80;i++) {
   const html='<html><body><section><header class="oVnAB K6hyTe"></header><div role="listitem"><a href="/store/apps/details?id=com.example.app'+i+'">Example</a><span>'+('x'.repeat(1024*1024))+i+'</span></div></section></body></html>';
   cached.push(parsePlaySearch(html));
 }
 global.gc();
 const retained=process.memoryUsage().heapUsed-start;
 console.log(JSON.stringify({retained,rows:cached.length}));
 if(retained>24*1024*1024)process.exitCode=1;
 `;
 const result=spawnSync(process.execPath,["--expose-gc","--import","tsx","--input-type=module","-e",script],{encoding:"utf8",timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
