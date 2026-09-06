import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseAllDocuments } from "yaml";
import type { k8sApi } from "@/lib/k8s/in-cluster";
import { triggerVaultIndex, VAULT_INDEX_REQUEST_PATH } from "@/lib/k8s/vault-trigger";
import { runVaultIndexTick, vaultScheduleKey } from "@/lib/vault/index-worker";

const ID = "11111111-1111-4111-8111-111111111111";
const NEXT = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-09-06T00:00:00Z");
function harness() {
  let signal = ID;
  let state = { completedRequestId: "", completedScheduleKey: "2026-09-05" };
  let indexes = 0;
  const writes: unknown[] = [];
  const request: typeof k8sApi = async (method, path, body) => {
    if (method === "GET") return { status: 200, json: path === VAULT_INDEX_REQUEST_PATH
      ? { data: { requestId: signal } }
      : { metadata: { resourceVersion: "1" }, data: state } };
    assert.equal(path, "/api/v1/namespaces/data/configmaps/vault-index-state");
    writes.push(body);
    state = (body as { data: typeof state }).data;
    return { status: 200, json: {} };
  };
  return { request, writes, index: async () => { indexes++; }, indexes: () => indexes,
    signal: (id: string) => { signal = id; }, state: () => state };
}

test("정기 인덱싱 경계는 KST 05:00이며 완료한 날짜·요청을 재실행하지 않는다", async () => {
  assert.equal(vaultScheduleKey(new Date("2026-09-05T19:59:59Z")), "2026-09-05");
  assert.equal(vaultScheduleKey(new Date("2026-09-05T20:00:00Z")), "2026-09-06");
  const h = harness();
  assert.equal(await runVaultIndexTick({ now, ...h }), "completed");
  assert.equal(await runVaultIndexTick({ now, ...h }), "idle");
  assert.equal(h.indexes(), 1);
});

test("진행 중 새 요청은 완료로 덮어쓰지 않고 다음 순서에서 실행한다", async () => {
  const h = harness();
  await runVaultIndexTick({ now, ...h, index: async () => { await h.index(); h.signal(NEXT); } });
  assert.equal(h.state().completedRequestId, ID);
  await runVaultIndexTick({ now, ...h });
  assert.equal(h.state().completedRequestId, NEXT);
  assert.equal(h.indexes(), 2);
});

test("조회 불가·손상 요청은 실행하지 않고 인덱싱 실패는 완료하지 않는다", async () => {
  const h = harness();
  await assert.rejects(runVaultIndexTick({ now, ...h, request: async () => ({ status: 403, json: {} }) }), /STATE_READ_FAILED/);
  h.signal("arbitrary-command");
  await assert.rejects(runVaultIndexTick({ now, ...h }), /REQUEST_INVALID/);
  assert.equal(h.indexes(), 0);
  h.signal(ID);
  await assert.rejects(runVaultIndexTick({ now, ...h, index: async () => { throw new Error("failed"); } }));
  assert.equal(h.writes.length, 0);
  assert.equal(await runVaultIndexTick({ now, ...h }), "completed");
});

test("완료 상태 CAS 실패는 성공으로 보고하지 않는다", async () => {
  const h = harness();
  const request: typeof k8sApi = (method, path, body) => method === "PATCH"
    ? Promise.resolve({ status: 409, json: {} }) : h.request(method, path, body);
  await assert.rejects(runVaultIndexTick({ now, ...h, request }), /CHECKPOINT_WRITE_FAILED/);
  assert.equal(h.writes.length, 0);
});

test("앱의 재인덱싱은 고정 ConfigMap에 UUID만 쓰고 Job을 생성하지 않는다", async () => {
  const calls: unknown[][] = [];
  const result = await triggerVaultIndex(async (...args) => { calls.push(args); return { status: 200, json: {} }; });
  assert.equal(result.triggered, true);
  assert.deepEqual(calls, [["PATCH", VAULT_INDEX_REQUEST_PATH, { data: { requestId: result.name } }]]);
  await assert.rejects(triggerVaultIndex(async () => ({ status: 403, json: {} })), /status 403/);
});

test("앱과 실행기 역할은 고정 ConfigMap만 허용하고 실행기 배포는 단일 Recreate다", () => {
  const documents = parseAllDocuments(readFileSync("k8s/vault-trigger-rbac.yaml", "utf8")).map((d) => d.toJSON());
  const app = documents.find((d) => d.kind === "Role" && d.metadata.name === "vault-indexer-trigger");
  assert.deepEqual(app.rules, [{ apiGroups: [""], resources: ["configmaps"], resourceNames: ["vault-index-request"], verbs: ["patch"] }]);
  for (const role of documents.filter((d) => d.kind === "Role")) {
    for (const rule of role.rules) {
      assert.deepEqual(rule.resources, ["configmaps"]);
      assert.ok(rule.resourceNames.length > 0);
      assert.ok(rule.verbs.every((verb: string) => ["get", "patch"].includes(verb)));
    }
  }
  const indexer = parseAllDocuments(readFileSync("k8s/vault-rag.yaml", "utf8")).map((d) => d.toJSON())
    .find((d) => d?.metadata?.name === "vault-indexer");
  assert.equal(indexer.kind, "Deployment");
  assert.equal(indexer.spec.replicas, 1);
  assert.equal(indexer.spec.strategy.type, "Recreate");
  assert.equal(indexer.spec.template.spec.serviceAccountName, "vault-indexer");
});
