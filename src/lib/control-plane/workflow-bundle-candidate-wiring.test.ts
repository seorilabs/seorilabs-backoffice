import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("candidate executor는 suspended immutable worker와 별도 server gate로 배포된다", () => {
  const manifest = source("k8s/workflow-bundle-candidate-executor.yaml");
  const deployment = source("k8s/deployment.yaml");
  const packageJson = source("package.json");
  assert.match(manifest, /kind: CronJob[\s\S]*suspend: true/u);
  assert.match(manifest, /concurrencyPolicy: Forbid/u);
  assert.match(manifest, /image: __BACKOFFICE_IMAGE_DIGEST__/u);
  assert.match(manifest, /automountServiceAccountToken: false/u);
  assert.match(manifest, /workflow-bundle-candidate-executor\.cjs/u);
  assert.match(manifest, /GITHUB_PRIVATE_KEY_FILE/u);
  assert.doesNotMatch(manifest, /ghp_|github_pat_|PERSONAL_ACCESS_TOKEN|GITHUB_TOKEN/u);
  assert.match(deployment, /name: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_DEPLOYED\s+value: "false"/u);
  assert.match(packageJson, /scripts\/workflow-bundle-candidate-executor\.ts/u);
});

test("candidate internal API는 bearer와 route-body attestation을 함께 소비한다", () => {
  const route = source("src/app/api/internal/workflow-bundle-candidate-executor/route.ts");
  const security = source("src/lib/control-plane/security.ts");
  assert.match(route, /authenticateWorkflowBundleCandidateExecutorRequest/u);
  assert.match(route, /verifyAndConsumeAgentAdapterAttestation/u);
  assert.match(route, /deploymentGate: "workflow-bundle-candidate"/u);
  assert.match(security, /WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_DEPLOYED === "true"/u);
  assert.doesNotMatch(route, /GITHUB_PRIVATE_KEY|createInstallationAccessToken/u);
});

test("candidate GitHub transport는 installation token을 callback 밖으로 반환하지 않는다", () => {
  const transport = source("src/lib/github/workflow-bundle-candidate-client.ts");
  const scoped = source("src/lib/github/scoped-installation-client.ts");
  assert.match(transport, /withFleetScopedGithubClient/u);
  assert.match(transport, /github\.workflow-bundle-candidate\.ready-pr/u);
  assert.match(scoped, /finally[\s\S]*revokeAccessToken/u);
  assert.doesNotMatch(transport, /process\.env\.(?:GITHUB_TOKEN|GH_TOKEN)|Authorization: token/u);
});
