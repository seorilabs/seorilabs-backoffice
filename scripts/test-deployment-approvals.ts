// 로컬 폐기용 MySQL에서 실행한다. 운영 DB를 받아서는 안 된다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { issueLinkCode, connectAccount, disconnectAccount } from "../src/lib/deployment-approvals/links";
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/approval_test", "폐기용 로컬 approval_test DB만 허용");
  const githubId = BigInt(Date.now());
  await prisma.user.create({ data: { githubId, login: `approval-test-${githubId}`, allowlisted: true } });
  const code = await issueLinkCode(githubId);
  const results = await Promise.allSettled([connectAccount(code, `${githubId}1`), connectAccount(code, `${githubId}2`)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1, "일회용 코드 동시 소비 1회");
  const stored = await prisma.discordLinkCode.findUniqueOrThrow({ where: { codeHash: createHash("sha256").update(code).digest("hex") } });
  assert.ok(stored.consumedAt); assert.notEqual(stored.codeHash, code);
  const row = await prisma.deploymentApproval.create({ data: { repository: "seorilabs/platform", runId: githubId, runAttempt: 1, environmentId: 20n, environment: "staging", sourceSha: "a".repeat(40), workflow: "Deploy staging", runNumber: 1, waitingSince: new Date(), observedAt: new Date() } });
  const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => prisma.deploymentApproval.updateMany({ where: { id: row.id, actionState: "IDLE" }, data: { actionState: "SENDING", actionCommandId: `test-${githubId}-${i}` } })));
  assert.equal(claims.reduce((sum, row) => sum + row.count, 0), 1, "동시 worker 요청 claim 1회");
  assert.equal((await prisma.deploymentApproval.updateMany({ where: { id: row.id, actionState: "IDLE" }, data: { actionState: "SENDING" } })).count, 0, "worker 재시작 후 재전송 claim 금지");
  const secondAttempt = await prisma.deploymentApproval.create({ data: { repository: "seorilabs/platform", runId: githubId, runAttempt: 2, environmentId: 20n, environment: "staging", sourceSha: "a".repeat(40), workflow: "Deploy staging", runNumber: 1, waitingSince: new Date(), observedAt: new Date() } });
  assert.notEqual(row.id, secondAttempt.id);
  await disconnectAccount(githubId, `approval-test-${githubId}`);
  assert.equal(await prisma.discordAccountLink.count({ where: { githubId } }), 0);
  console.log("MySQL: 코드 동시 소비, 계정 유일성, 요청 CAS, worker 재시작, 재실행 분리, 연결 해제 통과");
}
main().finally(() => prisma.$disconnect());
