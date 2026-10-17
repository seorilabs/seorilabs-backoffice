import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAllDocuments } from "yaml";

test("웹·명령·분석 작업기의 Claude 설정과 IH Secret 참조가 일치한다", () => {
  const targets = [
    ["k8s/deployment.yaml", "backoffice"],
    ["k8s/discord-workers.yaml", "backoffice-operator-command-worker"],
    ["k8s/operations-insights-worker.yaml", "backoffice-operations-insights"],
  ];
  for (const [path, name] of targets) {
    const documents = parseAllDocuments(readFileSync(path, "utf8")).map((doc) => doc.toJSON());
    const deployment = documents.find((doc) => doc.kind === "Deployment" && doc.metadata.name === name);
    assert.ok(deployment, name);
    const entries = deployment.spec.template.spec.containers[0].env as Array<{
      name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } };
    }>;
    const env = new Map(entries.map((entry) => [entry.name, entry]));
    assert.equal(env.get("CHAT_LLM_PROVIDER")?.value, "anthropic", name);
    assert.equal(env.get("FEATURE_CLAUDE_ENABLED")?.value, "true", name);
    assert.equal(env.get("CLAUDE_CHAT_MODEL")?.value, "claude-sonnet-5-5", name);
    assert.deepEqual(env.get("CLAUDE_API_KEY_IH")?.valueFrom?.secretKeyRef, {
      name: "backoffice-secrets", key: "CLAUDE_API_KEY_IH",
    }, name);
    assert.ok(!entries.some((entry) => entry.name.startsWith("MINIMAX_")), name);
  }
});
