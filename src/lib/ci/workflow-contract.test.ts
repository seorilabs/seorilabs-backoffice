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
  assert.equal(deploy.jobs?.verify?.["runs-on"], "seorilabs-rpi-arm64");
  assert.equal(
    deploy.jobs?.["migration-contract"]?.["runs-on"],
    "seorilabs-rpi-arm64-dind",
  );
  assert.deepEqual(
    deploy.jobs?.["migration-contract"]?.strategy?.matrix?.scenario,
    ["empty", "cutover"],
  );
  assert.equal(deploy.jobs?.["migration-contract"]?.uses, undefined);
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
  const deployMigrationRuns = runs(deploy.jobs?.["migration-contract"]);
  assert.ok(deployMigrationRuns.includes("bash scripts/test-migration-bootstrap.sh"));
  assert.ok(deployMigrationRuns.includes("bash scripts/test-migration-cutover.sh"));
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
