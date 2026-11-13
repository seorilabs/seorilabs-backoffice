import assert from "node:assert/strict";
import test from "node:test";
import { isCollectionBatch,collectionRunId } from "@/lib/notifications/collection-issues";
import { batchName } from "./notification";
test("수집과 실제 운영 작업의 분류를 구분하고 실행 ID는 생산자와 동일하게 쓴다",()=>{
 for(const name of ["book-sales-kdp","backoffice-ait-console-metrics","backoffice-analytics-collect","backoffice-analytics-recollect","backoffice-keyword-daily"])assert.equal(isCollectionBatch(name),true,name);
 for(const name of ["backoffice-db-backup","backoffice-finance-report"])assert.equal(isCollectionBatch(name),false,name);
 assert.equal(collectionRunId("batch:k8s:uid"),"uid");assert.equal(batchName("backoffice-analytics-collect"),"앱 사용 지표 수집");
});
