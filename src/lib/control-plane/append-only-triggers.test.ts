import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  REQUIRED_APPEND_ONLY_TRIGGERS,
  appendOnlyActionStatement,
  appendOnlyContractDigest,
  parseAppendOnlyTriggers,
  evaluateAppendOnlyTriggers,
  triggerVisibilityFromGrants,
  verifyAppendOnlyTriggers,
  type ObservedTrigger,
} from "@/lib/control-plane/append-only-triggers";

const migrationsRoot = join(process.cwd(), "prisma/migrations");

type YamlDocument = Record<string, never> & {
  kind?: string;
  [key: string]: unknown;
};

interface VerifierContainer {
  name: string;
  image: string;
  args: string[];
  volumeMounts?: Array<{ name: string; readOnly?: boolean }>;
}

interface VerifierPodSpec {
  automountServiceAccountToken: boolean;
  securityContext: { seccompProfile: { type: string } };
  initContainers: VerifierContainer[];
  containers: VerifierContainer[];
}

function verifierDocuments(): YamlDocument[] {
  return parseAllDocuments(
    readFileSync(join(process.cwd(), "k8s/provider-audit-trigger-verifier.yaml"), "utf8"),
  ).map((document) => document.toJS() as YamlDocument);
}

function verifierDocument(kind: string): YamlDocument {
  const found = verifierDocuments().find((document) => document.kind === kind);
  assert.ok(found, `verifier ${kind}이 없다`);
  return found;
}

function verifierPodSpec(): VerifierPodSpec {
  const cronJob = verifierDocument("CronJob") as unknown as {
    spec: { jobTemplate: { spec: { template: { spec: VerifierPodSpec } } } };
  };
  return cronJob.spec.jobTemplate.spec.template.spec;
}

function observed(
  overrides: Partial<ObservedTrigger> & Pick<ObservedTrigger, "name">,
): ObservedTrigger {
  const requirement = REQUIRED_APPEND_ONLY_TRIGGERS.find((entry) => entry.name === overrides.name);
  return {
    name: overrides.name,
    table: overrides.table ?? requirement?.table ?? "unknown_table",
    event: overrides.event ?? requirement?.event ?? "UPDATE",
    timing: overrides.timing ?? "BEFORE",
    statement: overrides.statement
      ?? appendOnlyActionStatement(requirement?.message ?? "append-only"),
  };
}

function compliantObservation(): ObservedTrigger[] {
  return REQUIRED_APPEND_ONLY_TRIGGERS.map((requirement) => observed({ name: requirement.name }));
}

test("required trigger 계약은 migration SQL 선언과 정확히 같다", () => {
  const declared = readdirSync(migrationsRoot)
    .sort()
    .flatMap((name) => {
      const sqlPath = join(migrationsRoot, name, "migration.sql");
      let sql: string;
      try {
        sql = readFileSync(sqlPath, "utf8");
      } catch {
        return [];
      }
      return parseAppendOnlyTriggers(sql);
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  assert.deepEqual(declared, [...REQUIRED_APPEND_ONLY_TRIGGERS]);
  assert.ok(declared.length > 0);
});

test("계약과 동일한 live readback만 통과한다", () => {
  assert.equal(
    verifyAppendOnlyTriggers(compliantObservation()),
    REQUIRED_APPEND_ONLY_TRIGGERS.length,
  );
});

test("trigger가 없으면 배포 gate가 fail-closed한다", () => {
  assert.throws(
    () => verifyAppendOnlyTriggers([]),
    /append-only trigger 계약 실패: .*missing:control_plane_provider_execution_event_no_delete/,
  );
  const partial = compliantObservation().slice(1);
  assert.throws(() => verifyAppendOnlyTriggers(partial), /missing:/);
});

test("MySQL이 보관한 trailing 세미콜론 차이는 계약 위반이 아니다", () => {
  // MySQL 9.2는 client가 보낸 statement를 그대로 저장해 같은 migration에서도
  // trigger마다 trailing `;` 유무가 갈린다. prisma migrate deploy 뒤 실측한 형태다.
  const observation = REQUIRED_APPEND_ONLY_TRIGGERS.map((requirement, index) => observed({
    name: requirement.name,
    statement: index === 0
      ? `${appendOnlyActionStatement(requirement.message)};`
      : `  ${appendOnlyActionStatement(requirement.message)}  `,
  }));
  assert.equal(verifyAppendOnlyTriggers(observation), REQUIRED_APPEND_ONLY_TRIGGERS.length);
});

test("timing·event·table·본문 변형은 통과하지 않는다", () => {
  const [first, ...rest] = compliantObservation();
  assert.throws(
    () => verifyAppendOnlyTriggers([{ ...first, timing: "AFTER" }, ...rest]),
    new RegExp(`mismatch:${first.name}`),
  );
  assert.throws(
    () => verifyAppendOnlyTriggers([{ ...first, table: "other_table" }, ...rest]),
    /mismatch:|missing:/,
  );
  assert.throws(
    () => verifyAppendOnlyTriggers([
      { ...first, statement: "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'weakened'" },
      ...rest,
    ]),
    new RegExp(`mismatch:${first.name}`),
  );
});

test("보호 table의 계약 밖 trigger는 우회로 취급한다", () => {
  const extra = observed({
    name: "control_plane_provider_execution_event_bypass",
    table: REQUIRED_APPEND_ONLY_TRIGGERS[0].table,
    event: "UPDATE",
    statement: appendOnlyActionStatement(REQUIRED_APPEND_ONLY_TRIGGERS[0].message),
  });
  assert.throws(
    () => verifyAppendOnlyTriggers([...compliantObservation(), extra]),
    /unexpected:control_plane_provider_execution_event_bypass/,
  );
});

test("보호 대상이 아닌 table의 trigger는 무시한다", () => {
  const unrelated: ObservedTrigger = {
    name: "unrelated_no_update",
    table: "unrelated_table",
    event: "UPDATE",
    timing: "BEFORE",
    statement: appendOnlyActionStatement("unrelated"),
  };
  assert.equal(
    verifyAppendOnlyTriggers([...compliantObservation(), unrelated]),
    REQUIRED_APPEND_ONLY_TRIGGERS.length,
  );
});

test("배포 gate script가 live trigger readback을 수행한다", () => {
  const script = readFileSync(join(process.cwd(), "scripts/verify-migration-state.ts"), "utf8");
  assert.match(script, /information_schema\.TRIGGERS/);
  assert.match(script, /evaluateAppendOnlyTriggers/);
  assert.match(script, /appendOnlyTriggers=\$\{appendOnlyTriggers\}/);
});

test("TRIGGER 권한이 없는 principal은 FORBIDDEN이다", () => {
  // production `backoffice`@`%`의 실제 SHOW GRANTS 출력이다.
  const grants = [
    "GRANT USAGE ON *.* TO `backoffice`@`%`",
    "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER ON `backoffice`.* TO `backoffice`@`%`",
  ];
  assert.equal(triggerVisibilityFromGrants(grants, "backoffice"), "FORBIDDEN");
});

test("schema 또는 전역 TRIGGER 권한은 VISIBLE이다", () => {
  assert.equal(
    triggerVisibilityFromGrants(["GRANT SELECT, TRIGGER ON `backoffice`.* TO `u`@`%`"], "backoffice"),
    "VISIBLE",
  );
  assert.equal(
    triggerVisibilityFromGrants(["GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` WITH GRANT OPTION"], "backoffice"),
    "VISIBLE",
  );
  assert.equal(
    triggerVisibilityFromGrants(["GRANT TRIGGER ON `other`.* TO `u`@`%`"], "backoffice"),
    "FORBIDDEN",
  );
});

test("보호 table 전부에 table 단위 TRIGGER 권한이 있어야 VISIBLE이다", () => {
  const table = REQUIRED_APPEND_ONLY_TRIGGERS[0].table;
  const partial = [`GRANT TRIGGER ON \`backoffice\`.\`${table}\` TO \`u\`@\`%\``];
  assert.equal(triggerVisibilityFromGrants(partial, "backoffice"), "VISIBLE");
  assert.equal(
    triggerVisibilityFromGrants(
      [`GRANT TRIGGER ON \`backoffice\`.\`unrelated\` TO \`u\`@\`%\``],
      "backoffice",
    ),
    "FORBIDDEN",
  );
});

test("FORBIDDEN은 부재로 단정하지 않고 배포를 막지 않는다", () => {
  assert.deepEqual(
    evaluateAppendOnlyTriggers({ visibility: "FORBIDDEN", observed: [] }),
    { visibility: "FORBIDDEN", verified: 0 },
  );
});

test("VISIBLE에서는 기존 fail-closed 계약이 그대로 적용된다", () => {
  assert.deepEqual(
    evaluateAppendOnlyTriggers({ visibility: "VISIBLE", observed: compliantObservation() }),
    { visibility: "VISIBLE", verified: REQUIRED_APPEND_ONLY_TRIGGERS.length },
  );
  assert.throws(
    () => evaluateAppendOnlyTriggers({ visibility: "VISIBLE", observed: [] }),
    /missing:/,
  );
});

test("배포 gate script는 권한을 먼저 읽고 FORBIDDEN을 구분해 출력한다", () => {
  const script = readFileSync(join(process.cwd(), "scripts/verify-migration-state.ts"), "utf8");
  assert.match(script, /SHOW GRANTS FOR CURRENT_USER\(\)/);
  assert.match(script, /triggerVisibilityFromGrants/);
  assert.match(script, /evaluateAppendOnlyTriggers/);
  assert.match(script, /FORBIDDEN\(migration principal에 TRIGGER 권한 없음/);
});

test("고정 verifier는 계약과 같은 trigger를 read-only로만 확인한다", () => {
  const manifest = readFileSync(
    join(process.cwd(), "k8s/provider-audit-trigger-verifier.yaml"),
    "utf8",
  );
  for (const requirement of REQUIRED_APPEND_ONLY_TRIGGERS) {
    assert.ok(manifest.includes(requirement.name), `${requirement.name} 미검증`);
    assert.ok(manifest.includes(`EVENT_MANIPULATION='${requirement.event}'`));
    assert.ok(manifest.includes(requirement.table));
  }
  assert.ok(manifest.includes(appendOnlyActionStatement(REQUIRED_APPEND_ONLY_TRIGGERS[0].message)));
  assert.match(manifest, /ACTION_TIMING='BEFORE'/);
  // 우회 trigger 차단: 보호 table 위 전체 개수도 확인한다.
  assert.match(manifest, /\[ "\$total" = "2" \] && \[ "\$exact" = "2" \]/);
  assert.doesNotMatch(manifest, /CREATE TRIGGER|DROP TRIGGER|GRANT |REVOKE |ALTER TABLE|DELETE FROM|INSERT INTO/);
  assert.match(manifest, /namespace: data/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
  // 임시 client 설정은 trap으로 지운다.
  assert.match(manifest, /trap 'rm -f "\$cnf"' EXIT INT TERM/);
});

test("verifier manifest의 계약 digest는 코드 계약과 같다", () => {
  const manifest = readFileSync(
    join(process.cwd(), "k8s/provider-audit-trigger-verifier.yaml"),
    "utf8",
  );
  const digest = appendOnlyContractDigest();
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.match(
    manifest,
    new RegExp(`seorilabs\\.dev/append-only-contract-digest: "${digest}"`),
  );
  assert.ok(manifest.includes(`value: "${digest}"`), "CONTRACT_DIGEST env가 계약과 다르다");
});

test("배포 script는 고정 verifier 관측을 rollout 선행조건으로 둔다", () => {
  const deploy = readFileSync(join(process.cwd(), "scripts/deploy-backoffice.sh"), "utf8");
  const readbackIndex = deploy.indexOf("read_trigger_state");
  const rolloutIndex = deploy.indexOf("availability-preserving web rollout");
  assert.ok(readbackIndex > 0, "관측 readback이 없다");
  assert.ok(readbackIndex < rolloutIndex, "관측이 rollout 뒤에 있다");
  assert.match(deploy, /trigger_observation_fresh/);
  assert.match(deploy, /"\$digest" = "\$expected_digest"/);
  // CI는 verifier workload를 만들거나 바꾸지 않는다.
  const executable = deploy
    .split("\n")
    .filter((line) => !/^\s*(#|echo )/.test(line))
    .join("\n");
  assert.doesNotMatch(executable, /(apply|create|render)\s+\S*provider-audit-trigger/);
});

test("CI deployer는 data namespace에서 workload를 만들 수 없다", () => {
  const rbac = readFileSync(join(process.cwd(), "k8s/ci-deployer-data-rbac.yaml"), "utf8");
  assert.match(rbac, /resourceNames: \["backoffice-provider-audit-trigger-state"\]/);
  assert.doesNotMatch(rbac, /resources: \["jobs"\]/);
  assert.doesNotMatch(rbac, /resources: \["pods"\]/);
  assert.doesNotMatch(rbac, /resources: \["secrets"\]/);
  assert.doesNotMatch(rbac, /verbs:.*create/);
  assert.doesNotMatch(rbac, /verbs:.*delete/);
});

test("DB root secret과 API token은 서로 다른 컨테이너에만 있다", () => {
  const pod = verifierPodSpec();
  assert.equal(pod.automountServiceAccountToken, false);

  const verify = pod.initContainers.find((container) => container.name === "verify");
  const publish = pod.containers.find((container) => container.name === "publish");
  assert.ok(verify && publish, "verify init container와 publish container가 필요하다");
  assert.equal(pod.containers.length, 1, "publisher 외 다른 container를 두지 않는다");

  const mounts = (container: VerifierContainer) =>
    (container.volumeMounts ?? []).map((mount) => mount.name);
  // root secret을 보는 컨테이너에는 token이 없다.
  assert.ok(mounts(verify).includes("mysql-root-password"));
  assert.ok(!mounts(verify).includes("api-token"));
  // token을 가진 컨테이너에는 DB secret이 없다.
  assert.ok(mounts(publish).includes("api-token"));
  assert.ok(!mounts(publish).includes("mysql-root-password"));
  // 공개 관측 파일만 공유하며 publisher는 읽기 전용으로 받는다.
  const shared = (publish.volumeMounts ?? []).find((mount) => mount.name === "observation");
  assert.equal(shared?.readOnly, true);
});

test("verifier 컨테이너 이미지는 모두 immutable digest로 고정한다", () => {
  const pod = verifierPodSpec();
  for (const container of [...pod.initContainers, ...pod.containers]) {
    assert.match(
      container.image,
      /^[^:]+@sha256:[0-9a-f]{64}$/,
      `${container.name} 이미지가 digest로 고정되지 않았다`,
    );
  }
});

test("publisher는 허용된 field와 형식만 기록한다", () => {
  const pod = verifierPodSpec();
  const publish = pod.containers[0].args.join("\n");
  // eval은 검증 전에 관측 값으로 shell command를 실행할 수 있어 금지한다.
  assert.doesNotMatch(publish, /\beval\b/);
  for (const field of ["status", "total", "exact", "contractDigest", "observedAt"]) {
    assert.match(publish, new RegExp(`\\b${field}\\) ${field}="\\$value" ;;`));
  }
  assert.match(publish, /허용되지 않은 관측 field/);
  assert.match(publish, /case "\$status" in PASS\|FAIL\)/);
  assert.match(publish, /"\$\{#contractDigest\}" -eq 64/);
  assert.match(publish, /"\$\{#observedAt\}" -eq 20/);
  // publisher는 DB에 접근하지 않는다.
  assert.doesNotMatch(publish, /mysql|SELECT|information_schema/i);
});

test("verifier egress는 MySQL과 API server로만 제한되고 DNS는 열지 않는다", () => {
  const policy = verifierDocument("NetworkPolicy") as unknown as {
    spec: {
      policyTypes: string[];
      ingress: unknown[];
      egress: Array<{ ports?: Array<{ port: number }> }>;
      podSelector: { matchLabels: Record<string, string> };
    };
  };
  assert.deepEqual([...policy.spec.policyTypes].sort(), ["Egress", "Ingress"]);
  assert.deepEqual(policy.spec.ingress, []);
  const ports = policy.spec.egress
    .flatMap((rule) => rule.ports ?? [])
    .map((port) => port.port)
    .sort((left, right) => left - right);
  assert.deepEqual(ports, [443, 3306]);
  assert.equal(
    policy.spec.podSelector.matchLabels["app.kubernetes.io/component"],
    "provider-audit-trigger-verifier",
  );
});

test("pod는 seccomp RuntimeDefault를 쓰고 service 환경값으로 접속한다", () => {
  const pod = verifierPodSpec();
  assert.equal(pod.securityContext.seccompProfile.type, "RuntimeDefault");
  const verify = pod.initContainers[0].args.join("\n");
  const publish = pod.containers[0].args.join("\n");
  // DNS를 열지 않으므로 cluster DNS 이름을 쓰지 않는다.
  assert.match(verify, /MYSQL_SERVICE_HOST/);
  assert.doesNotMatch(verify, /mysql\.data\.svc\.cluster\.local/);
  assert.match(publish, /KUBERNETES_SERVICE_HOST/);
  assert.doesNotMatch(publish, /https:\/\/kubernetes\.default\.svc\/api/);
});

test("verifier ServiceAccount는 결과 ConfigMap 하나만 patch한다", () => {
  const role = verifierDocument("Role") as unknown as { rules: unknown[] };
  assert.deepEqual(role.rules, [{
    apiGroups: [""],
    resources: ["configmaps"],
    resourceNames: ["backoffice-provider-audit-trigger-state"],
    verbs: ["get", "patch"],
  }]);
});

test("배포 script는 migration 완료 이후 관측만 인정한다", () => {
  const deploy = readFileSync(join(process.cwd(), "scripts/deploy-backoffice.sh"), "utf8");
  assert.match(deploy, /status\.completionTime/);
  assert.match(deploy, /migration_boundary_epoch/);
  // 같은 초 race를 막으려면 -gt여야 한다.
  assert.match(deploy, /"\$observed_epoch" -gt "\$migration_boundary_epoch"/);
  assert.doesNotMatch(deploy, /"\$observed_epoch" -ge "\$migration_boundary_epoch"/);
  // 벽시계 max age 단독 판정은 남기지 않는다.
  assert.doesNotMatch(deploy, /trigger_max_age/);
});
