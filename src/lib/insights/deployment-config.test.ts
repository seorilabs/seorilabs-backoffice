import { parseAllDocuments } from "yaml";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const channels = [
  "APP_OPS", "METRICS_DAILY", "RELEASE_OPS", "OPS_ALERTS", "USER_REVIEWS", "BACKOFFICE",
].map((key) => `DISCORD_CHANNEL_${key}_ID`);

for (const file of ["k8s/operations-insights-worker.yaml", "k8s/market-feedback-cronjobs.yaml"]) {
  for (const document of parseAllDocuments(readFileSync(file, "utf8"))) {
    const resource = document.toJS();
    test(`${resource.metadata.name}는 전용 알림 목적지를 선택할 공개 채널 설정만 받는다`, () => {
      const template = resource.kind === "Deployment"
        ? resource.spec.template
        : resource.spec.jobTemplate.spec.template;
      const variables = template.spec.containers[0].env as Array<{
        name: string;
        valueFrom?: { secretKeyRef?: { name: string; key: string } };
      }>;
      for (const name of channels) {
        const variable = variables.find((item) => item.name === name);
        assert.ok(variable, `${name}가 없어 모든 알림이 기본 채널로 몰림`);
        assert.equal(variable.valueFrom?.secretKeyRef?.name, "backoffice-secrets");
        assert.equal(variable.valueFrom?.secretKeyRef?.key, name);
      }
      for (const name of [
        "DISCORD_BOT_TOKEN", "DISCORD_TEAMMATE_SEORI_BOT_TOKEN",
        "GITHUB_PRIVATE_KEY", "GITHUB_DEPLOYMENT_APPROVER_TOKENS",
      ]) {
        assert.equal(variables.some((item) => item.name === name), false,
          `생산자에는 ${name}가 필요 없음`);
      }
    });
  }
}
