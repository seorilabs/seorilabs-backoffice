import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { fleetProjectPermissionDisposition } from "@/lib/control-plane/fleet-project-permission";
import type { GitHubInstallationPublicState } from "@/lib/github/installation-public-state";

function installationState(
  organizationProjects?: "read" | "write" | "admin",
): GitHubInstallationPublicState {
  return {
    installationId: "101",
    appId: "202",
    targetId: "303",
    repositorySelection: "all",
    targetType: "Organization",
    accountLogin: "seorilabs",
    permissions: {
      metadata: "read",
      ...(organizationProjects ? { organization_projects: organizationProjects } : {}),
    },
    events: [],
    suspended: false,
  };
}

test("organization Projects write/admin만 외부 projection capability로 인정한다", () => {
  for (const level of ["write", "admin"] as const) {
    assert.deepEqual(fleetProjectPermissionDisposition(installationState(level), "seorilabs"), {
      kind: "GRANTED",
      permissionLevel: level,
    });
  }
  for (const level of [undefined, "read"] as const) {
    const result = fleetProjectPermissionDisposition(installationState(level), "seorilabs");
    assert.equal(result.kind, "HUMAN_PERMISSION_REQUIRED");
    if (result.kind === "HUMAN_PERMISSION_REQUIRED") {
      assert.equal(result.errorCode, "GITHUB_ORG_PROJECTS_WRITE_PERMISSION_REQUIRED");
      assert.ok(result.missingRequirements.includes("permission:organization_projects:write"));
    }
  }
});

test("잘못된 owner와 suspended installation을 리소스 부재가 아닌 사람 권한 gate로 분리한다", () => {
  const state = {
    ...installationState("write"),
    accountLogin: "another-org",
    repositorySelection: "selected" as const,
    suspended: true,
  };
  const result = fleetProjectPermissionDisposition(state, "seorilabs");
  assert.equal(result.kind, "HUMAN_PERMISSION_REQUIRED");
  if (result.kind === "HUMAN_PERMISSION_REQUIRED") {
    assert.ok(result.missingRequirements.includes("installation:account-mismatch"));
    assert.ok(result.missingRequirements.includes("installation:all-repositories"));
    assert.ok(result.missingRequirements.includes("installation:suspended"));
  }
});

test("중앙 API와 reconciler는 Project를 생성하지 않고 singleton/public identity만 관리한다", () => {
  const service = readFileSync(
    join(process.cwd(), "src/lib/control-plane/fleet-project-binding.ts"),
    "utf8",
  );
  const route = readFileSync(
    join(process.cwd(), "src/app/api/control-plane/fleet-project-binding/route.ts"),
    "utf8",
  );
  const migration = readFileSync(
    join(process.cwd(), "prisma/migrations/20260830040000_fleet_project_binding/migration.sql"),
    "utf8",
  );
  assert.match(service, /FLEET_PROJECT_BINDING_ID = "seorilabs-fleet"/);
  assert.match(service, /organization_projects:write/);
  assert.match(service, /getInstallationContext\(\{ forceRefresh: true \}\)/);
  assert.match(service, /projectV2\(number: \$number\)/);
  assert.doesNotMatch(service, /createProjectV2|updateProjectV2|deleteProjectV2/);
  assert.match(route, /authenticateInternalRequest\(request, "control-plane"\)/);
  assert.match(route, /requireIdempotencyKey/);
  assert.match(migration, /fleet_project_binding_singleton_chk/);
  assert.match(migration, /`id` = 'seorilabs-fleet'/);
});

test("Issue projection target은 App.projectV2Id가 아니라 strict PRODUCT_APP 중앙 resolver를 사용한다", () => {
  const automation = readFileSync(
    join(process.cwd(), "src/lib/control-plane/automation-service.ts"),
    "utf8",
  );
  const start = automation.indexOf("export async function upsertFleetProjectProjection");
  const end = automation.indexOf("export async function refreshRunFleetProjection", start);
  const projectionSource = automation.slice(start, end);
  assert.match(projectionSource, /resolveFleetProjectSource\(issue\.app\)/);
  assert.match(projectionSource, /bindingRevision/);
  assert.doesNotMatch(projectionSource, /projectV2Id/);

  const binding = readFileSync(
    join(process.cwd(), "src/lib/control-plane/fleet-project-binding.ts"),
    "utf8",
  );
  assert.match(binding, /registration\.classification !== "PRODUCT_APP"/);
  assert.match(binding, /registration\.status !== "MANAGED"/);
  assert.match(binding, /pushed !== reconciled/);
});
