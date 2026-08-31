import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

import { upsertFleetProjectProjection } from "@/lib/control-plane/automation-service";
import {
  FLEET_PROJECT_BINDING_ID,
  reconcileFleetProjectBinding,
  setFleetProjectBindingDesiredState,
} from "@/lib/control-plane/fleet-project-binding";
import { ControlPlaneError } from "@/lib/control-plane/service";
import type { InstallationContext } from "@/lib/github/app";
import type { GitHubInstallationPublicState } from "@/lib/github/installation-public-state";

if (process.env.MIGRATION_FIXTURE_ACK !== "LOCAL_SCHEMA_ONLY") {
  throw new Error("MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY가 필요하다");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("Fleet Project fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("Fleet Project fixture DB 이름은 _contract_test로 끝나야 한다");
}

const prisma = new PrismaClient();
const nonce = crypto.randomUUID();
const actor = `fixture:fleet-project:${nonce}`;
const requestIds = {
  create: `fleet-project-create:${nonce}`,
  conflict: `fleet-project-conflict:${nonce}`,
  update: `fleet-project-update:${nonce}`,
};

function publicState(permission?: "read" | "write" | "admin"): GitHubInstallationPublicState {
  return {
    installationId: "101",
    appId: "202",
    targetId: "303",
    repositorySelection: "all",
    targetType: "Organization",
    accountLogin: "seorilabs",
    permissions: {
      metadata: "read",
      ...(permission ? { organization_projects: permission } : {}),
    },
    events: [],
    suspended: false,
  };
}

function context(input: {
  permission?: "read" | "write" | "admin";
  graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown>;
}): InstallationContext {
  return {
    publicState: publicState(input.permission),
    repositorySelection: "all",
    targetType: "Organization",
    accountLogin: "seorilabs",
    octokit: { graphql: input.graphql } as unknown as InstallationContext["octokit"],
  };
}

async function main() {
  let productAppId: string | null = null;
  let infraAppId: string | null = null;
  try {
    const created = await setFleetProjectBindingDesiredState({
      desired: { organizationLogin: "seorilabs", projectNumber: 7, expectedRevision: 0 },
      actor,
      idempotencyKey: requestIds.create,
      expectedOrganization: "seorilabs",
    });
    assert.equal(created.duplicate, false);
    assert.equal(created.changed, true);
    assert.equal(created.binding.revision, 1);
    assert.equal(created.binding.status, "PENDING");

    const replay = await setFleetProjectBindingDesiredState({
      desired: { organizationLogin: "seorilabs", projectNumber: 7, expectedRevision: 0 },
      actor,
      idempotencyKey: requestIds.create,
      expectedOrganization: "seorilabs",
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.binding.revision, 1);

    await assert.rejects(
      setFleetProjectBindingDesiredState({
        desired: { organizationLogin: "seorilabs", projectNumber: 8, expectedRevision: 0 },
        actor,
        idempotencyKey: requestIds.conflict,
        expectedOrganization: "seorilabs",
      }),
      (error) => error instanceof ControlPlaneError
        && error.code === "FLEET_PROJECT_BINDING_REVISION_CONFLICT",
    );

    let forbiddenGraphqlCalls = 0;
    const permissionGate = await reconcileFleetProjectBinding({
      getInstallationContext: async () => context({
        permission: "read",
        graphql: async () => {
          forbiddenGraphqlCalls += 1;
          throw new Error("permission preflight should prevent GraphQL");
        },
      }),
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    assert.equal(permissionGate.gate, "HUMAN_PERMISSION_REQUIRED");
    assert.equal(permissionGate.binding?.lastErrorCode, "GITHUB_ORG_PROJECTS_WRITE_PERMISSION_REQUIRED");
    assert.equal(forbiddenGraphqlCalls, 0, "권한 부재를 project absent query로 오판하면 안 된다");

    const effectivePermissionGate = await reconcileFleetProjectBinding({
      getInstallationContext: async () => context({
        permission: "write",
        graphql: async () => {
          throw Object.assign(new Error("provider detail must not persist"), { status: 403 });
        },
      }),
      now: () => new Date("2026-08-30T00:00:30.000Z"),
    });
    assert.equal(effectivePermissionGate.gate, "HUMAN_PERMISSION_REQUIRED");
    assert.equal(
      effectivePermissionGate.binding?.lastErrorCode,
      "GITHUB_ORG_PROJECTS_WRITE_PERMISSION_REQUIRED",
    );
    assert.doesNotMatch(
      effectivePermissionGate.binding?.lastError ?? "",
      /provider detail/,
      "provider 원문 오류를 공개 binding에 보존하면 안 된다",
    );

    const verified = await reconcileFleetProjectBinding({
      getInstallationContext: async () => context({
        permission: "write",
        graphql: async (_query, variables) => {
          assert.deepEqual(variables, { organization: "seorilabs", number: 7 });
          return {
            organization: {
              id: "O_seorilabs",
              login: "seorilabs",
              projectV2: {
                id: "PVT_seorilabs_fleet",
                number: 7,
                title: "Seorilabs Fleet",
                url: "https://github.com/orgs/seorilabs/projects/7",
                closed: false,
              },
            },
          };
        },
      }),
      now: () => new Date("2026-08-30T00:01:00.000Z"),
    });
    assert.equal(verified.gate, "VERIFIED");
    assert.equal(verified.binding?.projectNodeId, "PVT_seorilabs_fleet");
    assert.equal(verified.binding?.permissionLevel, "write");

    const productRepoId = BigInt(`8${Date.now()}`);
    const productRepo = `seorilabs/p6-project-${nonce}`;
    const productApp = await prisma.app.create({
      data: {
        slug: `p6-project-${nonce}`,
        displayName: "P6 Fleet Project Fixture",
        repoFullName: productRepo,
        repoId: productRepoId,
        type: "APP",
        engine: "RN",
        status: "ACTIVE",
        marketTargets: [],
        projectV2Id: "PVT_legacy_must_be_ignored",
      },
    });
    productAppId = productApp.id;
    await prisma.repositoryRegistration.create({
      data: {
        repoId: productRepoId,
        repoFullName: productRepo,
        defaultBranch: "main",
        archived: false,
        status: "MANAGED",
        managementKind: "APP",
        classification: "PRODUCT_APP",
        lastDefaultPushSha: "a".repeat(40),
        lastReconciledSha: "a".repeat(40),
      },
    });
    await prisma.issueMirror.create({
      data: {
        appId: productApp.id,
        repoFullName: productRepo,
        number: 1,
        nodeId: `I_product_${nonce}`,
        title: "PRODUCT_APP issue",
        state: "OPEN",
        assignees: [],
        labels: ["autopilot", "P1"],
        priority: "P1",
        isAutopilot: true,
        ghCreatedAt: new Date(),
        ghUpdatedAt: new Date(),
      },
    });
    const projection = await upsertFleetProjectProjection(productRepo, 1);
    assert.equal(projection?.projectNodeId, "PVT_seorilabs_fleet");
    assert.equal(projection?.bindingRevision, 1);
    assert.notEqual(projection?.projectNodeId, productApp.projectV2Id);

    const infraRepoId = productRepoId + 1n;
    const infraRepo = `seorilabs/p6-infra-${nonce}`;
    const infraApp = await prisma.app.create({
      data: {
        slug: `p6-infra-${nonce}`,
        displayName: "P6 Infra Fixture",
        repoFullName: infraRepo,
        repoId: infraRepoId,
        type: "APP",
        engine: "RN",
        status: "ACTIVE",
        marketTargets: [],
      },
    });
    infraAppId = infraApp.id;
    await prisma.repositoryRegistration.create({
      data: {
        repoId: infraRepoId,
        repoFullName: infraRepo,
        defaultBranch: "main",
        archived: false,
        status: "MANAGED",
        managementKind: "UNCLASSIFIED",
        classification: "INFRA_REPO",
        lastDefaultPushSha: "b".repeat(40),
        lastReconciledSha: "b".repeat(40),
      },
    });
    await prisma.issueMirror.create({
      data: {
        appId: infraApp.id,
        repoFullName: infraRepo,
        number: 1,
        nodeId: `I_infra_${nonce}`,
        title: "INFRA issue",
        state: "OPEN",
        assignees: [],
        labels: ["autopilot"],
        isAutopilot: true,
        ghCreatedAt: new Date(),
        ghUpdatedAt: new Date(),
      },
    });
    assert.equal(await upsertFleetProjectProjection(infraRepo, 1), null);
    assert.equal(await prisma.fleetProjectProjection.count({
      where: { issueNodeId: `I_infra_${nonce}` },
    }), 0);

    const changed = await setFleetProjectBindingDesiredState({
      desired: { organizationLogin: "seorilabs", projectNumber: 8, expectedRevision: 1 },
      actor,
      idempotencyKey: requestIds.update,
      expectedOrganization: "seorilabs",
    });
    assert.equal(changed.binding.revision, 2);
    assert.equal(changed.binding.status, "PENDING");
    assert.equal((await prisma.fleetProjectProjection.findUniqueOrThrow({
      where: { id: projection!.id },
    })).status, "SUPERSEDED");
  } finally {
    await prisma.fleetProjectProjection.deleteMany({
      where: { issueNodeId: { in: [`I_product_${nonce}`, `I_infra_${nonce}`] } },
    });
    await prisma.issueMirror.deleteMany({
      where: { nodeId: { in: [`I_product_${nonce}`, `I_infra_${nonce}`] } },
    });
    for (const appId of [productAppId, infraAppId]) {
      if (appId) await prisma.app.deleteMany({ where: { id: appId } });
    }
    await prisma.repositoryRegistration.deleteMany({
      where: { repoFullName: { contains: nonce } },
    });
    await prisma.fleetProjectBinding.deleteMany({ where: { id: FLEET_PROJECT_BINDING_ID } });
    await prisma.automationMutationRequest.deleteMany({
      where: { requestId: { in: Object.values(requestIds) } },
    });
    await prisma.auditLog.deleteMany({ where: { actorLogin: actor } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
