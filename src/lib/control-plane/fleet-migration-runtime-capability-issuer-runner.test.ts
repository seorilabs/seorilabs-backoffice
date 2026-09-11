import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { parseAllDocuments } from "yaml";

const execFileAsync = promisify(execFile);
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const DETECTOR_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const IMAGE = `registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:${"a".repeat(64)}`;
const EXECUTION_ID = "fleet-runtime-execution-0001";
const FINGERPRINT = "b".repeat(64);
const DIGEST = createHash("sha256").update(EXECUTION_ID).digest("hex");
const SHORT = DIGEST.slice(0, 20);

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  assert.ok(value && !Array.isArray(value) && typeof value === "object");
  return value as JsonRecord;
}
function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function byKind(items: JsonRecord[], kind: string): JsonRecord {
  const matches = items.filter((item) => item.kind === kind);
  assert.equal(matches.length, 1);
  return matches[0];
}
function named(items: unknown[], name: string): JsonRecord {
  const matches = items.map(record).filter((item) => item.name === name);
  assert.equal(matches.length, 1);
  return matches[0];
}

test("runtime capability issuer renders only exact suspended one-run resources", async () => {
  const [runner, issuerSource] = await Promise.all([
    readFile("scripts/run-fleet-migration-runtime-capability-issuer.sh", "utf8"),
    readFile("scripts/fleet-migration-runtime-capability-issuer.ts", "utf8"),
  ]);
  const { stdout: base } = await execFileAsync("bash", [
    "scripts/render-manifest.sh",
    "k8s/fleet-migration-runtime-capability-issuer-job.yaml",
    IMAGE,
    SOURCE_SHA,
  ]);
  const jobName = `fleet-runtime-issuer-${DIGEST.slice(0, 40)}`;
  const roleName = `fleet-runtime-issuer-${SHORT}`;
  const serviceAccount = roleName;
  const configMap = `fleet-runtime-public-${DIGEST.slice(0, 24)}`;
  const tokenSecret = `fleet-runtime-token-${DIGEST.slice(0, 24)}`;
  const rendered = base
    .replaceAll("__FLEET_MIGRATION_DETECTOR_SOURCE_SHA__", DETECTOR_SHA)
    .replaceAll("__FLEET_MIGRATION_EXECUTION_ID__", EXECUTION_ID)
    .replaceAll("__FLEET_MIGRATION_RUNTIME_KEY_FINGERPRINT__", FINGERPRINT)
    .replaceAll("__FLEET_MIGRATION_RUNTIME_CONFIG_MAP__", configMap)
    .replaceAll("__FLEET_MIGRATION_GITHUB_TOKEN_SECRET__", tokenSecret)
    .replaceAll("__FLEET_MIGRATION_RUNTIME_ISSUER_JOB__", jobName)
    .replaceAll("__FLEET_MIGRATION_RUNTIME_ISSUER_SERVICE_ACCOUNT__", serviceAccount)
    .replaceAll("__FLEET_MIGRATION_RUNTIME_ISSUER_ROLE__", roleName)
    .replaceAll("__KUBERNETES_API_SERVICE_CIDR__", "10.152.183.1/32")
    .replaceAll("__KUBERNETES_API_ENDPOINT_CIDR__", "192.168.0.100/32")
    .replaceAll("__KUBERNETES_API_ENDPOINT_PORT__", "16443");
  assert.doesNotMatch(rendered, /__[A-Z0-9_]+__|:latest/u);
  const resources = parseAllDocuments(rendered).map((document) => record(document.toJSON()));
  assert.deepEqual(resources.map(({ kind }) => kind).sort(), [
    "ConfigMap", "Job", "NetworkPolicy", "Role", "RoleBinding", "Secret", "ServiceAccount",
  ]);

  const secret = byKind(resources, "Secret");
  const publicConfigMap = byKind(resources, "ConfigMap");
  assert.equal(record(secret.metadata).name, tokenSecret);
  assert.deepEqual(secret.data, {});
  assert.equal(secret.immutable, undefined);
  assert.equal(record(publicConfigMap.metadata).name, configMap);
  assert.deepEqual(publicConfigMap.data, {});
  assert.equal(publicConfigMap.immutable, undefined);

  const role = byKind(resources, "Role");
  assert.deepEqual(list(role.rules).map(record), [
    { apiGroups: [""], resources: ["secrets"], resourceNames: [tokenSecret], verbs: ["get", "update", "delete"] },
    { apiGroups: [""], resources: ["configmaps"], resourceNames: [configMap], verbs: ["get", "update", "delete"] },
  ]);
  const job = byKind(resources, "Job");
  const spec = record(job.spec);
  const podSpec = record(record(record(spec.template).spec));
  assert.equal(record(job.metadata).name, jobName);
  assert.equal(spec.suspend, true);
  assert.equal(spec.backoffLimit, 0);
  assert.equal(spec.activeDeadlineSeconds, 600);
  assert.equal(podSpec.serviceAccountName, serviceAccount);
  assert.equal(podSpec.automountServiceAccountToken, false);
  const container = record(list(podSpec.containers)[0]);
  assert.equal(container.image, IMAGE);
  assert.deepEqual(container.command, ["/usr/bin/prlimit", "--core=0:0", "--", "node", "/app/scripts-dist/fleet-migration-runtime-capability-issuer.cjs"]);
  assert.equal(record(container.securityContext).readOnlyRootFilesystem, true);
  const env = list(container.env).map(record);
  assert.equal(named(env, "BACKOFFICE_SOURCE_SHA").value, SOURCE_SHA);
  assert.equal(named(env, "FLEET_MIGRATION_DETECTOR_SOURCE_SHA").value, DETECTOR_SHA);
  assert.equal(named(env, "FLEET_MIGRATION_EXECUTION_ID").value, EXECUTION_ID);
  assert.equal(named(env, "FLEET_MIGRATION_RUNTIME_ATTESTATION_KEY_FINGERPRINT").value, FINGERPRINT);
  assert.deepEqual(record(named(env, "DATABASE_URL").valueFrom).secretKeyRef, { name: "fleet-migration-shadow-db", key: "DATABASE_URL" });
  assert.deepEqual(record(named(env, "CONTROL_PLANE_SNAPSHOT_SIGNING_KEY").valueFrom).secretKeyRef, { name: "backoffice-control-plane-snapshot-signing", key: "CONTROL_PLANE_SNAPSHOT_SIGNING_KEY" });
  assert.equal(env.some(({ valueFrom }) => (JSON.stringify(valueFrom) ?? "").includes("backoffice-secrets")), false);

  const volumes = list(podSpec.volumes).map(record);
  assert.deepEqual(volumes.map(({ name }) => name), ["github-app", "runtime-signing", "kubernetes-auth", "tmp"]);
  const projection = record(named(volumes, "kubernetes-auth").projected);
  assert.equal(projection.defaultMode, 440);
  assert.match(rendered, /defaultMode: 0440/u);
  const sources = list(projection.sources).map(record);
  assert.equal(record(sources[0].serviceAccountToken).expirationSeconds, 600);
  assert.equal(record(sources[0].serviceAccountToken).path, "token");

  assert.match(runner, /crane_bin config.*org\.opencontainers\.image\.revision/su);
  assert.ok(runner.indexOf("actual_job=") < runner.indexOf("unsuspend_patch="));
  assert.match(runner, /op:"test",path:"\/metadata\/uid"/u);
  assert.match(runner, /op:"test",path:"\/metadata\/resourceVersion"/u);
  assert.match(runner, /patch "job\/\$job_name" --type=json/u);
  assert.doesNotMatch(runner, /patch "job\/\$job_name" --type=merge/u);
  assert.match(runner, /ownerReferences/u);
  assert.match(runner, /--arg job "\$job_name"/u);
  assert.match(runner, /containerStatuses\[0\]\.imageID/u);
  assert.match(runner, /logs "pod\/\$pod_name"/u);
  assert.doesNotMatch(runner, /get secret\/[^\n]+ -o (?:json|yaml)/u);
  // kubectl은 `delete TYPE name1 name2`를 전부 TYPE의 이름으로 읽는다. 종전 단언이 그
  // 형태를 그대로 고정하고 있어 Role/ServiceAccount/NetworkPolicy가 삭제되지 않는 상태가
  // 테스트로 얼어 있었다. TYPE/NAME 쌍을 요구한다.
  assert.match(runner, /"rolebinding\/\$role_name"/u);
  assert.match(runner, /"role\/\$role_name"/u);
  assert.match(runner, /"serviceaccount\/\$service_account"/u);
  assert.match(runner, /"networkpolicy\/\$role_name"/u);

  for (const requiredBoundary of [
    "evaluateFleetMigrationShadowReadiness",
    "verifySnapshot",
    "getFleetScopedGithubTokenIssuer",
    "issueFleetMigrationGithubCapabilityToSink",
    "signFleetMigrationPublicAttestation",
    "createFleetMigrationKubernetesCapabilitySink",
    "resolveFleetMigrationApprovedProofDigests",
  ]) assert.ok(issuerSource.includes(requiredBoundary));
  assert.match(issuerSource, /secretValuesReturned: false/u);
  assert.match(issuerSource, /isIPv4\(value\)/u);
  assert.match(issuerSource, /requiredIpv4\("KUBERNETES_SERVICE_HOST"\)/u);
  assert.doesNotMatch(issuerSource, /process\.stdout\.write\([^)]*token/su);
});

test("빈 Pod 목록에서도 jsonpath가 죽지 않는다", () => {
  // kubectl jsonpath의 인덱스 접근은 빈 배열에서 오류로 끝난다. suspended Job에는 Pod가
  // 없는 것이 정상이므로, 그 상태를 확인하는 가드가 오히려 스크립트를 죽였다. set -e와
  // 겹쳐 발급이 시작도 못 했다. `[*]`는 빈 목록에서 빈 문자열을 돌려주고 원소가 하나면
  // 같은 이름을 준다. #346의 `{{len .data}}` nil 문제와 같은 계열이다.
  for (const script of [
    "run-fleet-migration-runtime-capability-issuer.sh",
    "run-fleet-migration-bootstrap-shadow.sh",
  ]) {
    const source = readFileSync(join(process.cwd(), "scripts", script), "utf8");
    assert.doesNotMatch(
      source,
      /jsonpath=\{\.items\[0\]/u,
      `${script}가 빈 목록에서 죽는 인덱스 jsonpath를 쓴다`,
    );
    assert.match(
      source,
      /jsonpath=\{\.items\[\*\]\.metadata\.name\}/u,
      `${script}가 안전한 jsonpath를 쓰지 않는다`,
    );
  }
});

test("NetworkPolicy를 비교하는 실행기는 모두 빈 목록을 정규화한다", () => {
  // API server는 빈 목록 필드를 저장하지 않는다. canonical spec의 `ingress: []`가 readback에서
  // 사라지므로 raw `.spec` 비교는 항상 어긋난다. #346이 두 실행기에 정규화를 넣었는데
  // inventory issuer에는 빠져 있어, 원장 발급이 첫 실행에서 그대로 막혔다.
  const RUNNERS = [
    "run-fleet-migration-runtime-capability-issuer.sh",
    "run-fleet-migration-bootstrap-shadow.sh",
    "run-fleet-migration-inventory-issuer.sh",
  ] as const;
  for (const runner of RUNNERS) {
    const source = readFileSync(join(process.cwd(), "scripts", runner), "utf8");
    if (!/networkpolicy/iu.test(source)) continue;
    assert.match(
      source,
      /with_entries\(select\(\.value != \[\]\)\)/u,
      `${runner}가 NetworkPolicy 비교에서 빈 목록을 정규화하지 않는다`,
    );
    // 반증: 정규화 없는 raw spec 비교가 남아 있으면 잡는다.
    assert.doesNotMatch(
      source,
      /-Sc '\.spec'/u,
      `${runner}에 정규화 없는 raw spec 비교가 남아 있다`,
    );
  }
});

test("살아 있는 signer 객체 비교는 server defaulting을 거친 기대값을 쓴다", () => {
  // API server는 Deployment/Service에 기본값을 채워 저장한다(protocol: TCP,
  // successThreshold: 1, timeoutSeconds: 1 ...). client dry-run 렌더링본에는 그 값이 없어
  // 전체 객체 비교가 원리적으로 통과할 수 없다. NetworkPolicy의 `ingress: []`와 같은 계열이며,
  // 실제로 원장 발급의 signer 관문이 한 번도 통과한 적이 없었다.
  const source = readFileSync(
    join(process.cwd(), "scripts/run-fleet-migration-inventory-issuer.sh"),
    "utf8",
  );
  assert.match(source, /apply --dry-run=server/u, "signer 기대값을 server dry-run으로 얻지 않는다");
  const signerExpectation = /expected_signer=.*signer_server_documents/u;
  const serviceExpectation = /expected_service=.*signer_server_documents/u;
  assert.match(source, signerExpectation, "Deployment 기대값이 server dry-run 결과에서 오지 않는다");
  assert.match(source, serviceExpectation, "Service 기대값이 server dry-run 결과에서 오지 않는다");

  // 반증: client 렌더링본으로 되돌아가면 잡는다.
  assert.doesNotMatch(
    source,
    /expected_signer="\$\(printf '%s' "\$signer_documents"/u,
    "Deployment 기대값이 client 렌더링본으로 되돌아갔다",
  );

  // Job은 아직 존재하지 않는 객체를 스스로 create한 뒤 readback하므로 client 렌더링본이 맞다.
  // server apply dry-run은 last-applied 주석을 붙여 create 결과와 달라진다.
  assert.match(source, /expected_job="\$\(printf '%s' "\$issuer_documents"/u);
});

test("임시 RBAC 정리는 TYPE/NAME 쌍으로 지정한다", () => {
  // kubectl은 `delete TYPE name1 name2`를 전부 TYPE의 이름으로 읽는다. 종전 형태
  // `delete rolebinding $n role $n serviceaccount $sa networkpolicy $n`는 Role,
  // ServiceAccount, NetworkPolicy를 삭제 대상으로 만들지 못했고, NotFound 오류로 set -e가
  // 실행기를 중단시켜 발급 성공 뒤 최종 evidence 출력이 잘렸다.
  const source = readFileSync(
    join(process.cwd(), "scripts/run-fleet-migration-runtime-capability-issuer.sh"),
    "utf8",
  );
  assert.match(source, /"rolebinding\/\$role_name"/u);
  assert.match(source, /"role\/\$role_name"/u);
  assert.match(source, /"serviceaccount\/\$service_account"/u);
  assert.match(source, /"networkpolicy\/\$role_name"/u);
  // 반증: 공백으로 나열하는 옛 형태가 남아 있으면 잡는다.
  assert.doesNotMatch(
    source,
    /delete rolebinding "\$role_name" role /u,
    "TYPE을 공백으로 나열하는 형태가 남아 있다",
  );
  // 제거 단언은 명령이 아니라 readback loop이 한다. 그 loop은 그대로 있어야 한다.
  assert.match(source, /terminal runtime capability issuer support 권한 제거 readback에 실패했다/u);
});
