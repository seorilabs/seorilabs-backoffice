import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

interface WorkflowStep {
  run?: string;
  uses?: string;
}

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  "runs-on"?: string;
  strategy?: {
    matrix?: {
      scenario?: string[];
    };
  };
  steps?: WorkflowStep[];
  uses?: string;
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

function workflow(name: string): Workflow {
  return parse(readFileSync(join(process.cwd(), ".github/workflows", name), "utf8")) as Workflow;
}

function runs(job: WorkflowJob | undefined): string[] {
  return job?.steps?.flatMap((step) => step.run ? [step.run] : []) ?? [];
}

test("PR은 전체 build를 검증하고 main은 검증 뒤 production 이미지만 한 번 빌드한다", () => {
  const ci = workflow("ci.yml");
  const deploy = workflow("deploy.yml");
  const migration = workflow("migration-contract.yml");
  const ciRuns = runs(ci.jobs?.verify);
  const deployVerifyRuns = runs(deploy.jobs?.verify);

  assert.deepEqual(Object.keys(ci.on ?? {}), ["pull_request"]);
  assert.ok(ciRuns.includes("pnpm build"));

  assert.equal(
    ci.jobs?.["migration-contract"]?.uses,
    "./.github/workflows/migration-contract.yml",
  );
  assert.equal(ci.jobs?.verify?.["runs-on"], "ubuntu-latest");
  assert.equal(migration.jobs?.mysql92?.["runs-on"], "ubuntu-latest");
  assert.equal(deploy.jobs?.verify?.["runs-on"], "ubuntu-latest");
  assert.equal(
    deploy.jobs?.["migration-contract"]?.uses,
    "./.github/workflows/migration-contract.yml",
  );
  assert.deepEqual(deploy.jobs?.build?.needs, ["verify", "migration-contract"]);
  assert.equal(deploy.jobs?.deploy?.needs, "build");
  assert.equal(
    deploy.jobs?.deploy?.if,
    "github.event_name != 'workflow_dispatch' || inputs.deploy",
  );
  assert.ok(deployVerifyRuns.includes("pnpm typecheck"));
  assert.ok(deployVerifyRuns.includes("pnpm lint"));
  assert.ok(deployVerifyRuns.includes("pnpm test"));
  assert.ok(deployVerifyRuns.includes("bash scripts/check-ci-deployer-permissions.test.sh"));
  assert.ok(deployVerifyRuns.includes("bash scripts/render-manifest.test.sh"));
  assert.ok(!deployVerifyRuns.includes("pnpm build"));
  assert.ok(deploy.jobs?.build?.steps?.some((step) => step.uses === "docker/build-push-action@v7"));
  const deploySource = readFileSync(
    join(process.cwd(), ".github/workflows/deploy.yml"),
    "utf8",
  );
  assert.match(deploySource, /Record immutable candidate/);
  assert.match(deploySource, /org\.opencontainers\.image\.revision=/);
  assert.doesNotMatch(deploySource, /\$\{\{ env\.IMAGE \}\}:latest/);
  const migrationSource = readFileSync(
    join(process.cwd(), ".github/workflows/migration-contract.yml"),
    "utf8",
  );
  assert.match(migrationSource, /scenario: \[empty, cutover\]/);
  assert.match(migrationSource, /scripts\/test-migration-bootstrap\.sh/);
  assert.match(migrationSource, /scripts\/test-migration-cutover\.sh/);
  assert.ok(migration.on?.workflow_call !== undefined);
});

test("production 이미지 빌드는 hosted 크로스빌드 계약을 유지한다", () => {
  const deploy = workflow("deploy.yml");
  const deploySource = readFileSync(
    join(process.cwd(), ".github/workflows/deploy.yml"),
    "utf8",
  );

  // self-hosted 러너를 쓰지 않는다. 이 저장소는 public 이고, org 러너그룹의
  // "Allow public repositories" 는 해제 상태를 유지한다(그 플래그는 그룹 단위라
  // 켜면 access list 의 모든 public 저장소가 열린다. fork PR 은 fork 의 워크플로
  // 파일로 실행되므로 외부인이 ARC 를 겨냥할 수 있다).
  // k8s API 는 공개 도달 가능하므로 배포도 hosted 에서 kubectl 로 수행한다.
  assert.equal(deploy.jobs?.build?.["runs-on"], "ubuntu-latest");
  assert.equal(deploy.jobs?.verify?.["runs-on"], "ubuntu-latest");
  assert.equal(deploy.jobs?.deploy?.["runs-on"], "ubuntu-latest");
  for (const file of ["ci.yml", "deploy.yml", "migration-contract.yml"]) {
    for (const [name, job] of Object.entries(workflow(file).jobs ?? {})) {
      const runner = job["runs-on"];
      if (runner !== undefined) {
        assert.equal(runner, "ubuntu-latest", `${file} 의 ${name} 이 self-hosted 러너를 쓴다`);
      }
    }
  }

  // 러너가 amd64 이므로 kubectl 도 amd64 를 받아야 한다. 어긋나면 배포 시점에
  // exec format error 로만 드러난다.
  assert.match(deploySource, /bin\/linux\/amd64\/kubectl/);
  assert.doesNotMatch(deploySource, /bin\/linux\/arm64\/kubectl/);

  // 러너가 클러스터를 떠났으므로 클러스터 내부 빌더를 가리키면 안 된다.
  // 남아 있으면 DNS 를 못 찾아 조용히 깨진다.
  assert.doesNotMatch(deploySource, /driver:\s*remote/);
  assert.doesNotMatch(deploySource, /buildkitd\.platform\.svc\.cluster\.local/);

  // 런타임 스테이지만 타깃 아키텍처로 실행되므로 QEMU 가 필요하다.
  assert.ok(
    deploy.jobs?.build?.steps?.some((step) =>
      step.uses?.startsWith("docker/setup-qemu-action@")
    ),
  );

  // 크로스빌드가 성립하려면 산출물이 빌드 호스트 아키텍처와 무관해야 한다.
  // sharp 제외를 되돌리면 빌드 호스트의 .node 가 arm64 이미지에 딸려 들어간다.
  const nextConfig = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  assert.match(nextConfig, /outputFileTracingExcludes/);
  assert.match(nextConfig, /@img/);
  assert.match(nextConfig, /sharp/);

  // Prisma arm64 query engine 은 빌드 호스트가 아니라 이 선언으로 생성하고,
  // standalone을 runtime에 복사하기 전에 host-native engine을 제거한다.
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  assert.match(schema, /binaryTargets\s*=\s*\[[^\]]*linux-arm64-openssl-3\.0\.x/);

  // 무거운 JS 빌드는 BUILDPLATFORM(러너 네이티브)에서, 런타임 스테이지만 타깃에서.
  const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /FROM --platform=\$BUILDPLATFORM node:[\d.]+-bookworm-slim AS build-base/,
  );
  assert.match(dockerfile, /^FROM node:[\d.]+-bookworm-slim AS runtime$/m);
  assert.doesNotMatch(dockerfile, /FROM --platform=\$BUILDPLATFORM[^\n]*AS runtime/);

  const buildIndex = dockerfile.indexOf("&& pnpm build");
  const pruneIndex = dockerfile.indexOf(
    "&& sh scripts/prune-standalone-prisma-engines.sh .next/standalone",
  );
  const runtimeIndex = dockerfile.indexOf("AS runtime");
  assert.ok(buildIndex >= 0, "production Next build가 필요하다");
  assert.ok(pruneIndex > buildIndex, "Prisma engine 정리는 Next build 뒤여야 한다");
  assert.ok(runtimeIndex > pruneIndex, "Prisma engine 정리는 runtime COPY 전이어야 한다");
});
