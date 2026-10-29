import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse, parseAllDocuments } from "yaml";
import { frequentBatch } from "./notification";

test("시간별 묶음은 30분 미만 간격에만 적용한다", () => {
  const cron = { namespace: "platform" as const, name: "example", uid: "cron", schedule: "*/30 * * * *", timeZone: "Asia/Seoul", suspended: false, lastScheduleAt: null };
  const now = new Date("2026-10-24T00:00:00Z");
  assert.equal(frequentBatch(cron, now), false);
  assert.equal(frequentBatch({ ...cron, schedule: "*/15 * * * *" }, now), true);
  assert.equal(frequentBatch({ ...cron, schedule: "* * * * *" }, now), true);
  assert.equal(frequentBatch({ ...cron, schedule: "30 3,9,15,21 * * *" }, now), false);
});

test("운영 worker에 공개 채널이 설정되고 Job 식별 패치는 OAuth와 일정을 건드리지 않는다", () => {
  const workers = parseAllDocuments(readFileSync("k8s/discord-workers.yaml", "utf8")).map((doc) => doc.toJSON());
  const worker = workers.find((item) => item.metadata.name === "backoffice-notification-worker");
  const env = worker.spec.template.spec.containers[0].env;
  assert.match(env.find((item: { name: string }) => item.name === "SLACK_CHANNEL_BATCH_MONITORING_ID").value, /^[CG][A-Z0-9]{8,}$/);
  const patch = parse(readFileSync("k8s/console-metrics-batch-identity-patch.yaml", "utf8"));
  assert.deepEqual(Object.keys(patch.spec), ["jobTemplate"]);
  const container = patch.spec.jobTemplate.spec.template.spec.containers[0];
  assert.equal(container.name, "collector");
  assert.deepEqual(container.env, [{ name: "BATCH_JOB_UID", valueFrom: { fieldRef: { fieldPath: "metadata.labels['batch.kubernetes.io/controller-uid']" } } }]);
});
