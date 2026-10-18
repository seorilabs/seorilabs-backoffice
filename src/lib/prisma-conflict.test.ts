import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { retryPrismaConflict } from "./prisma-conflict";

const error = (code: string) => new Prisma.PrismaClientKnownRequestError("synthetic DB conflict", { code, clientVersion: "fixture" });
test("신규 키 경쟁과 교착이 풀리면 DB 작업을 완료한다", async () => {
  for (const code of ["P2002", "P2034"]) {
    let calls = 0;
    assert.equal(await retryPrismaConflict(async () => { if (++calls === 1) throw error(code); return 7; }), 7);
    assert.equal(calls, 2);
  }
});
test("계속되는 충돌은 상한에서 실패하고 다른 오류는 재전송하지 않는다", async () => {
  let calls = 0;
  await assert.rejects(retryPrismaConflict(async () => { calls++; throw error("P2002"); }), { code: "P2002" });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retryPrismaConflict(async () => { calls++; throw error("P1001"); }), { code: "P1001" });
  assert.equal(calls, 1);
});
