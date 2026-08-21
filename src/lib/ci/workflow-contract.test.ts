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
  needs?: string | string[];
  steps?: WorkflowStep[];
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
  const ciRuns = runs(ci.jobs?.verify);
  const deployVerifyRuns = runs(deploy.jobs?.verify);

  assert.deepEqual(Object.keys(ci.on ?? {}), ["pull_request"]);
  assert.ok(ciRuns.includes("pnpm build"));

  assert.equal(deploy.jobs?.build?.needs, "verify");
  assert.equal(deploy.jobs?.deploy?.needs, "build");
  assert.ok(deployVerifyRuns.includes("pnpm typecheck"));
  assert.ok(deployVerifyRuns.includes("pnpm lint"));
  assert.ok(deployVerifyRuns.includes("pnpm test"));
  assert.ok(deployVerifyRuns.includes("bash scripts/render-manifest.test.sh"));
  assert.ok(!deployVerifyRuns.includes("pnpm build"));
  assert.ok(deploy.jobs?.build?.steps?.some((step) => step.uses === "docker/build-push-action@v7"));
});
