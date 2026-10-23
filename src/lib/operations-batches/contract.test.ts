import test from "node:test";
import assert from "node:assert/strict";
import { batchInputSchema, dailyWindow, expectedSchedules, incidentAction, summarizeRuns } from "./contract";
import { normalizeKubernetes } from "./kubernetes";
import { handleBatchPost } from "./http";
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

test("개인피드와 임의 명령, 로그, 환경변수는 수집 계약에 들어오지 않는다", () => {
  const input = { kind: "kubernetes", observedAt: "2026-10-24T00:00:00Z", cronJobs: [], runs: [] };
  assert.ok(batchInputSchema.safeParse(input).success);
  assert.equal(batchInputSchema.safeParse({ ...input, namespace: "tasks" }).success, false);
  assert.throws(() => normalizeKubernetes("tasks", [], []));
});

test("운영 3개 네임스페이스의 배치 조회만 허용하고 Secret, Pod, tasks 권한은 주지 않는다", () => {
  const resources = parseAllDocuments(readFileSync("k8s/operations-batch-observer-rbac.yaml", "utf8")).map((doc) => doc.toJSON());
  assert.deepEqual(resources.filter((r) => r.kind === "RoleBinding").map((r) => r.metadata.namespace).sort(), ["container-registry", "data", "platform"]);
  assert.equal(resources.some((r) => r.kind === "ClusterRoleBinding"), false);
  assert.deepEqual(resources.find((r) => r.kind === "ClusterRole").rules, [{ apiGroups: ["batch"], resources: ["cronjobs", "jobs"], verbs: ["get", "list"] }]);
});

test("인증 뒤에만 본문을 읽고 개인피드와 원본 명령 필드는 저장 전에 거부한다", async () => {
  let read = 0; let saved = 0;
  const body = () => { read++; return Promise.resolve(JSON.stringify({ kind: "kubernetes", observedAt: "2026-10-24T00:00:00Z", cronJobs: [], runs: [], env: "sensitive" })); };
  const save = async () => { saved++; return { accepted: 0 }; };
  assert.equal((await handleBatchPost(null, "fixture", body, save)).status, 401);
  assert.equal(read, 0);
  assert.equal((await handleBatchPost("fixture", "fixture", body, save)).status, 400);
  assert.equal(saved, 0);
  assert.equal((await handleBatchPost("fixture", "fixture", async () => "x".repeat(2_000_001), save)).status, 413);
});

test("예정 실행 수는 실제 시간대와 주간 일정, 정지 여부를 따른다", () => {
  const { start, end } = dailyWindow(new Date("2026-10-24T00:00:00Z"));
  const cron = { schedule: "*/5 * * * *", timeZone: "Asia/Seoul", suspended: false };
  assert.equal(expectedSchedules(cron, start, end), 288);
  assert.equal(expectedSchedules({ ...cron, schedule: "0 4 * * 0" }, start, end), 0);
  assert.equal(expectedSchedules({ ...cron, suspended: true }, start, end), 0);
  assert.equal(expectedSchedules({ ...cron, schedule: "@daily" }, start, end), null);
});

test("Pod 재시도는 실패로 판단하지 않고 Job 최종 조건만 사용한다", () => {
  const cron = { metadata: { name: "example", uid: "cron-uid" }, spec: { schedule: "* * * * *" } };
  const job = { metadata: { uid: "job-uid", creationTimestamp: "2026-10-24T00:00:00Z", ownerReferences: [{ kind: "CronJob", name: "example", uid: "cron-uid" }] }, status: { failed: 2 } };
  assert.equal(normalizeKubernetes("platform", [cron], [job]).runs[0].status, "running");
  const final = { ...job, status: { ...job.status, conditions: [{ type: "Failed", status: "True", lastTransitionTime: "2026-10-24T00:01:00Z" }] } };
  assert.equal(normalizeKubernetes("platform", [cron], [final]).runs[0].status, "failed");
  assert.equal(normalizeKubernetes("platform", [cron], [{ ...final, metadata: { ...job.metadata, ownerReferences: [] } }]).runs.length, 0);
});

test("늦은 실패는 새 성공을 되돌리지 않고 후속 성공만 복구한다", () => {
  assert.equal(incidentAction("failed", new Date(1), new Date(2)), "none");
  assert.equal(incidentAction("failed", new Date(3), new Date(2)), "fail");
  assert.equal(incidentAction("succeeded", new Date(3), new Date(2)), "recover");
  assert.equal(incidentAction("running", new Date(3), null), "none");
});

test("매일 09시 KST 경계와 중복 실행을 보존한다", () => {
  assert.equal(dailyWindow(new Date("2026-10-23T23:59:59Z")).key, "2026-10-23");
  const window = dailyWindow(new Date("2026-10-24T00:00:00Z"));
  assert.equal(window.key, "2026-10-24");
  assert.equal(window.start.toISOString(), "2026-10-23T00:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-10-24T00:00:00.000Z");
  assert.deepEqual(summarizeRuns([{ id: "a", status: "succeeded" }, { id: "a", status: "succeeded" }, { id: "b", status: "failed" }, { id: "c", status: "running" }]), { succeeded: 1, failed: 1, running: 1 });
});
