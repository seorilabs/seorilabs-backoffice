import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  APPROVED_CALLER_RECONCILIATION_ADAPTER_RUNTIME_IDENTITY,
  APPROVED_CALLER_RECONCILIATION_EXECUTOR_ATTESTATION_ROUTE,
  TRUSTED_EXECUTOR_BINDINGS,
  peerTrustedExecutorEnvNames,
} from "@/lib/control-plane/trusted-executor-bindings";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("caller 반증기는 후보 실행기와 다른 route, principal, 배포 gate를 쓴다", () => {
  const candidate = TRUSTED_EXECUTOR_BINDINGS["workflow-bundle-candidate"];
  const approved = TRUSTED_EXECUTOR_BINDINGS["approved-caller-reconciliation"];
  assert.notEqual(candidate.attestationRoute, approved.attestationRoute);
  assert.notEqual(candidate.env.deployed, approved.env.deployed);
  assert.notEqual(candidate.env.token, approved.env.token);
  assert.notEqual(candidate.env.publicKey, approved.env.publicKey);
  assert.notEqual(
    candidate.expected?.adapterRuntimeIdentity,
    approved.expected?.adapterRuntimeIdentity,
  );
  // 자기 gate의 env 이름은 peer 목록에 없어야 값 재사용 검사가 의미를 갖는다.
  assert.ok(!peerTrustedExecutorEnvNames("approved-caller-reconciliation", "token")
    .includes(approved.env.token));
  assert.ok(peerTrustedExecutorEnvNames("approved-caller-reconciliation", "token")
    .includes(candidate.env.token));
});

test("internal API는 bearer와 route-body attestation을 함께 소비한다", () => {
  const route = source("src/app/api/internal/approved-caller-reconciliation-executor/route.ts");
  assert.match(
    route,
    /authenticateTrustedExecutorRequest\(request, "approved-caller-reconciliation"\)/u,
  );
  assert.match(route, /verifyAndConsumeAgentAdapterAttestation/u);
  assert.match(route, /deploymentGate: "approved-caller-reconciliation"/u);
  assert.match(
    source("src/lib/control-plane/trusted-executor-bindings.ts"),
    /deployed: "APPROVED_CALLER_RECONCILIATION_EXECUTOR_DEPLOYED"/u,
  );
  assert.doesNotMatch(route, /GITHUB_PRIVATE_KEY|createInstallationAccessToken/u);
});

test("세션 미들웨어는 실행기 route를 가로채지 않는다", () => {
  assert.match(source("src/middleware.ts"), /approved-caller-reconciliation-executor/u);
});

test("CronJob은 계약 호출에 필요한 것만 열고 기본은 suspend다", () => {
  const manifest = source("k8s/approved-caller-reconciliation-executor.yaml");
  assert.match(manifest, /suspend: true/u);
  assert.match(manifest, /approved-caller-reconciliation-executor\.mjs/u);
  assert.match(manifest, new RegExp(APPROVED_CALLER_RECONCILIATION_ADAPTER_RUNTIME_IDENTITY, "u"));
  assert.match(manifest, /readOnlyRootFilesystem: true/u);
  assert.match(manifest, /automountServiceAccountToken: false/u);
  // 파드는 egress proxy 밖으로 나가지 못한다.
  assert.match(manifest, /app\.kubernetes\.io\/name: seori-auth-egress-proxy/u);
  assert.doesNotMatch(manifest, /-----BEGIN|PRIVATE KEY/u);
});

test("git egress는 이 실행기 client identity에만 열린다", () => {
  const proxy = source("k8s/seori-auth-egress-proxy.yaml");
  assert.match(
    proxy,
    /sa\/approved-caller-reconciliation-executor=backoffice\.vzyx\.xyz,api\.github\.com,github\.com;/u,
  );
  assert.match(
    proxy,
    /sa\/workflow-bundle-candidate-executor=backoffice\.vzyx\.xyz,api\.github\.com;/u,
  );
});

test("실행기는 계약을 정적 import하지 않는다", () => {
  const generator = source("src/lib/control-plane/approved-caller-generator.ts");
  // 정적 import는 Next 서버 번들을 깨뜨린다(top-level await ESM).
  assert.doesNotMatch(
    generator,
    /^import\s[^;]*seorilabs-org-contracts\/repo-contract\/workflow-bundle-v5/mu,
  );
  assert.match(generator, /await import\(\s*"seorilabs-org-contracts\/repo-contract\/workflow-bundle-v5"/u);
  // 실행기 번들만 ESM이어야 dynamic import가 CJS require로 접히지 않는다.
  assert.match(
    source("package.json"),
    /scripts\/approved-caller-reconciliation-executor\.ts --bundle --platform=node --format=esm/u,
  );
});

test("attestation route는 실행기 목록에서만 나온다", () => {
  const attestation = source("src/lib/control-plane/agent-adapter-attestation.ts");
  assert.match(attestation, /trustedExecutorAttestationRoutes\(\)\.includes\(route\)/u);
  assert.equal(
    APPROVED_CALLER_RECONCILIATION_EXECUTOR_ATTESTATION_ROUTE,
    "/api/internal/approved-caller-reconciliation-executor",
  );
});
