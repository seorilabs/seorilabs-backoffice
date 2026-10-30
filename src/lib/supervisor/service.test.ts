import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  createProposal,
  submitObservations,
  registerTarget,
  decideProposal,
  claimRun,
  reportRun,
  setMode,
  reservePublications,
} from "./service";
import { digest } from "./contracts";
const local =
  /^mysql:\/\/[^@]+@(?:127\.0\.0\.1|localhost):\d+\/(?:supervisor_test|backoffice_[a-z_]+_contract_test)$/.test(
    process.env.DATABASE_URL || "",
  );
test(
  "AC1-4 실제 MySQL에서 승인, claim, 만료, 취소, 응답 유실과 복구를 확인한다",
  { skip: !local },
  async () => {
    const targetId = "qa-" + randomUUID();
    const target = {
      id: targetId,
      name: "격리된 테스트 문서",
      kind: "TOOL",
      repository: null,
      appId: null,
      policySha: null,
      enabled: true,
    };
    await registerTarget(target);
    const now = new Date(),
      later = new Date(now.getTime() + 86400000).toISOString();
    const observation = {
      id: "obs-" + randomUUID(),
      targetId,
      problemKey: "broken",
      source: "test",
      summary: "테스트에서 읽은 실패 근거",
      references: ["file:test-evidence"],
      observedAt: now.toISOString(),
      expiresAt: later,
      waitUntil: null,
      samples: 10,
      minSamples: 5,
    };
    const body = {
      targetId,
      problemKey: "broken",
      title: "누락된 문서 내용을 복구한다",
      problem: "실제 실패 근거",
      observationIds: [observation.id],
      scope: "격리 문서만 변경",
      design: "승인 설계",
      preview: "내용 변경",
      acceptance: ["문서 내용이 복구된다"],
      tests: "개발 환경에서 내용 확인",
      testCommands: [["node", "--version"]],
      verification: {
        kind: "readback",
        argv: ["node", "--version"],
        expectedText: "v",
      },
      tools: ["codex", "git"],
      executor: "codex",
      timeLimitMinutes: 5,
      impact: 3,
      confidence: 0.9,
      effortMinutes: 5,
      deadline: null,
      release: null,
      binding: {
        kind: "git",
        commit: "a".repeat(40),
        designPath: "docs/design/design.md",
        testPlanPath: "docs/design/test-plan.json",
        designSha256: "b".repeat(64),
        testPlanSha256: "c".repeat(64),
      },
    };
    try {
      await submitObservations([observation]);
      assert.equal(
        (await submitObservations([observation])).accepted,
        1,
        "동일 관측 재전송",
      );
      const p = await createProposal(body, "pc");
      assert.equal((await createProposal(body, "pc")).id, p.id);
      await assert.rejects(
        decideProposal({
          id: p.id,
          version: 2,
          digest: p.digest,
          decision: "approve",
          actor: "@human",
        }),
        /VERSION_CHANGED/,
      );
      await assert.rejects(
        decideProposal({
          id: p.id,
          version: 1,
          digest: digest("other"),
          decision: "approve",
          actor: "@human",
        }),
        /VERSION_CHANGED/,
      );
      const decision = {
        id: p.id,
        version: p.version,
        digest: p.digest,
        decision: "approve" as const,
        actor: "@human",
      };
      const [a, b] = await Promise.all([
        decideProposal(decision),
        decideProposal(decision),
      ]);
      assert.equal(a.runId, b.runId, "승인은 하나의 실행만 만든다");
      await setMode("ACTIVE", "@human");
      const claims = await Promise.all([
        claimRun("pc"),
        claimRun("another-pc"),
      ]);
      assert.equal(
        claims.filter((c) => !!c.run).length,
        1,
        "전역 한 건만 claim",
      );
      const run = claims.find((c) => c.run)!.run!;
      const owner = run.executionOwner!;
      const report = {
        requestId: randomUUID(),
        generation: run.generation!,
        kind: "heartbeat" as const,
        sessionId: randomUUID(),
        summary: "실행 시작",
        evidence: [],
        checkpoint: {},
      };
      await assert.rejects(
        reportRun(run.id, "other", report),
        /OWNERSHIP_LOST/,
      );
      await assert.rejects(
        reportRun(run.id, owner, { ...report, generation: 99 }),
        /OWNERSHIP_LOST/,
      );
      await reportRun(run.id, owner, report);
      assert.equal(
        (await reportRun(run.id, owner, report)).duplicate,
        true,
        "응답 유실 후 동일 보고 재전송",
      );
      await assert.rejects(
        reportRun(run.id, owner, { ...report, summary: "다른 본문" }),
        /ID_CONFLICT/,
      );
      await prisma.operatorCommandRun.update({
        where: { id: run.id },
        data: { leaseUntil: new Date(0) },
      });
      const expired = await claimRun("pc");
      assert.equal(expired.run, null);
      assert.ok(expired.active);
      await assert.rejects(
        reportRun(run.id, owner, {
          ...report,
          requestId: randomUUID(),
          kind: "succeeded",
          evidence: ["file:proof"],
          checkpoint: { testsPassed: true, readbackVerified: true },
        }),
        /LEASE_LOST/,
      );
      await reportRun(run.id, owner, {
        ...report,
        requestId: randomUUID(),
        kind: "paused",
        evidence: ["file:local-readback"],
        checkpoint: { processStopped: true },
      });
      assert.equal(
        (await claimRun("pc")).run,
        null,
        "외부 결과 확인 전 잠금 유지",
      );
      await decideProposal({
        ...decision,
        decision: "reconcile",
        evidence: ["https://github.com/example/tool/pull/1"],
      });
      assert.equal(
        (await prisma.workCoordinator.findUniqueOrThrow({ where: { id: 1 } }))
          .activeRunId,
        null,
      );
      const p2 = await createProposal(
        { ...body, design: "수정한 새 설계" },
        "pc",
      );
      assert.equal(p2.version, 2);
      await assert.rejects(decideProposal(decision), /SUPERSEDED/);
      await decideProposal({
        ...decision,
        id: p2.id,
        version: p2.version,
        digest: p2.digest,
      });
      const second = (await claimRun("pc")).run!;
      await decideProposal({
        id: p2.id,
        version: 2,
        digest: p2.digest,
        decision: "cancel",
        actor: "@human",
      });
      await assert.rejects(
        reportRun(second.id, "pc", {
          ...report,
          requestId: randomUUID(),
          generation: second.generation!,
          kind: "succeeded",
          evidence: ["file:proof"],
          checkpoint: { testsPassed: true, readbackVerified: true },
        }),
        /LEASE_LOST/,
      );
      await reportRun(second.id, "pc", {
        ...report,
        requestId: randomUUID(),
        generation: second.generation!,
        kind: "stopped",
        evidence: ["file:verified-stop"],
        checkpoint: { processStopped: true, readbackVerified: true },
      });
      assert.equal(
        (
          await prisma.operatorCommandRun.findUniqueOrThrow({
            where: { id: second.id },
          })
        ).status,
        "CANCELLED",
      );
      const excluded = await createProposal(
        { ...body, problemKey: "broken", design: "세 번째 설계" },
        "pc",
      );
      await decideProposal({
        id: excluded.id,
        version: excluded.version,
        digest: excluded.digest,
        decision: "exclude",
        actor: "@human",
      });
      await assert.rejects(
        createProposal({ ...body, design: "제외 우회" }, "pc"),
        /ALREADY_HANDLED/,
      );
      await setMode("OBSERVE", "@human");
      assert.deepEqual(await reservePublications(), []);
    } finally {
      await prisma.notificationEvent.deleteMany({
        where: { dedupeKey: { startsWith: "supervisor-result:" } },
      });
      const ps = await prisma.workProposal.findMany({
        where: { targetId },
        select: { id: true, runId: true },
      });
      await prisma.workEvent.deleteMany({
        where: {
          OR: [
            { proposalId: { in: ps.map((p) => p.id) } },
            { actor: { in: ["pc", "another-pc", "@human"] } },
          ],
        },
      });
      await prisma.workProposal.deleteMany({ where: { targetId } });
      await prisma.operatorCommandRun.deleteMany({
        where: { id: { in: ps.flatMap((p) => (p.runId ? [p.runId] : [])) } },
      });
      await prisma.workObservation.deleteMany({ where: { targetId } });
      await prisma.workTarget.delete({ where: { id: targetId } });
      await prisma.workCoordinator.update({
        where: { id: 1 },
        data: { activeRunId: null, mode: "OBSERVE" },
      });
      await prisma.$disconnect();
    }
  },
);
