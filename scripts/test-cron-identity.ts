import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transpileModule, ScriptTarget } from "typescript";
import { prisma } from "../src/lib/prisma";
import { retryPrismaConflict } from "../src/lib/prisma-conflict";
import { normalizeLabels, priorityFromLabels, isAutopilot, hasEvidence, isBlocked } from "../src/lib/domain/labels";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/backoffice_qa");
  const key = `qa-cron-${Date.now()}`, repo = `qa/${key}`;
  const app = await prisma.app.create({ data: { slug: key, displayName: "격리 식별자 검증", repoFullName: repo, type: "APP", engine: "RN", marketTargets: [] } });
  const old = await prisma.issueMirror.create({ data: { appId: app.id, repoFullName: repo, number: 18, nodeId: `${key}-old`, title: "과거 Issue", state: "OPEN", source: "BACKOFFICE", clientReqId: `${key}-old-marker`, linkedPrUrl: "https://example.invalid/old-pr", assignees: [], labels: [], ghCreatedAt: new Date("2026-07-01"), ghUpdatedAt: new Date("2026-07-01") } });
  const current = { number: 18, node_id: `${key}-new`, title: "현재 Issue", state: "open", created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z", repository_url: `https://api.github.com/repos/${repo}` };
  const source = readFileSync("src/lib/sync/mirror.ts", "utf8");
  const body = source.slice(source.indexOf("// ── Issue"), source.indexOf("// ── Pull Request"));
  const compiled = transpileModule(body.replaceAll("export async", "async"), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const ports = { prisma, retryPrismaConflict, normalizeLabels, priorityFromLabels, isAutopilot, hasEvidence, isBlocked,
    resolveAppId: async () => app.id, BO_MARKER: /<!--\s*bo:req=([0-9a-fA-F-]+)\s*-->/,
    getInstallationOctokit: async () => ({ rest: { issues: { get: async () => ({ data: current }) } } }),
    upsertFleetProjectProjection: async () => {},
  };
  const upsert = new Function(...Object.keys(ports), `${compiled}; return upsertIssue;`)(...Object.values(ports));
  await Promise.all([upsert(repo, current), upsert(repo, current)]);
  await upsert(repo, { ...current, node_id: old.nodeId, title: "지연된 과거 이벤트" });
  const saved = await prisma.issueMirror.findUniqueOrThrow({ where: { id: old.id } });
  assert.equal(saved.nodeId, current.node_id); assert.equal(saved.title, current.title);
  assert.equal(saved.linkedPrUrl, null); assert.equal(saved.clientReqId, null);
  const audits = await prisma.auditLog.findMany({ where: { entityId: old.id, action: "github.issue.identity.reconciled" } });
  assert.equal(audits.length, 1); assert.match(JSON.stringify(audits[0].payload), new RegExp(old.nodeId));
  assert.equal(await prisma.issueMirror.count({ where: { repoFullName: repo, number: 18 } }), 1);
  console.log(JSON.stringify({ ok: true, concurrentReplacement: true, oldEventIgnored: true, auditCount: audits.length, rowIdPreserved: true, externalGithubCalls: 0 }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
