import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { transpileModule, ScriptTarget } from "typescript";
import { normalizeLabels, priorityFromLabels, isAutopilot, hasEvidence, isBlocked } from "@/lib/domain/labels";
import { retryPrismaConflict } from "@/lib/prisma-conflict";

const source = readFileSync("src/lib/sync/mirror.ts", "utf8");
const section = source.slice(source.indexOf("// ── Issue"), source.indexOf("// ── Pull Request"));
const compiled = transpileModule(section.replaceAll("export async", "async"), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;

function harness() {
  const audits: unknown[] = [];
  const current = { number: 18, node_id: "new-node", title: "새 이슈", state: "open", created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z", repository_url: "https://api.github.com/repos/seorilabs/example" };
  let row = { id: "mirror", nodeId: "old-node", repoFullName: "seorilabs/example", number: 18, ghUpdatedAt: new Date("2026-07-01"), linkedPrUrl: "old-pr", clientReqId: "old-marker" } as Record<string, unknown>;
  let reads = 0;
  let failRead = false;
  const db = {
    issueMirror: {
      findUnique: async ({ where }: { where: { nodeId?: string } }) => where.nodeId ? row.nodeId === where.nodeId ? row : null : row,
      upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        if (row.nodeId !== create.nodeId) throw new Error("P2002 repoFullName_number");
        row = { ...row, ...update }; return row;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => { row = { ...row, ...data }; return row; },
    },
    auditLog: { create: async (input: unknown) => { audits.push(input); } },
    $queryRaw: async () => [{ id: "mirror" }],
  };
  const ports = {
    prisma: { ...db, $transaction: async (fn: (value: typeof db) => unknown) => fn(db) },
    resolveAppId: async () => "app1", normalizeLabels, priorityFromLabels, isAutopilot, hasEvidence, isBlocked,
    BO_MARKER: /<!--\s*bo:req=([0-9a-fA-F-]+)\s*-->/,
    upsertFleetProjectProjection: async () => {}, retryPrismaConflict,
    getInstallationOctokit: async () => ({ rest: { issues: { get: async () => { reads++; if (failRead) throw new Error("HTTP 403"); return { data: current }; } } } }),
  };
  const upsert = new Function(...Object.keys(ports), `${compiled}; return upsertIssue;`)(...Object.values(ports));
  return { current, audits, upsert, row: () => row, reads: () => reads, failRead: () => { failRead = true; } };
}

test("이름과 번호가 재사용되면 공식 재조회와 감사 보존 후 현재 식별자로 복구한다", async () => {
  const h = harness(); await h.upsert("seorilabs/example", h.current);
  assert.equal(h.reads(), 1); assert.equal(h.row().nodeId, "new-node");
  assert.equal(h.row().linkedPrUrl, null); assert.equal(h.row().clientReqId, null);
  assert.match(JSON.stringify(h.audits), /old-node/);
  await h.upsert("seorilabs/example", { ...h.current, node_id: "old-node", title: "늦은 과거 이벤트" });
  assert.equal(h.row().nodeId, "new-node"); assert.equal(h.row().title, "새 이슈");
});

test("공식 재조회가 실패하면 충돌 행을 수정하지 않는다", async () => {
  const h = harness(); h.failRead();
  await assert.rejects(h.upsert("seorilabs/example", h.current), /403/);
  assert.equal(h.row().nodeId, "old-node"); assert.equal(h.audits.length, 0);
});
