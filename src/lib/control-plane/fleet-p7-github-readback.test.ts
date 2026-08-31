import assert from "node:assert/strict";
import test from "node:test";

import {
  FLEET_P7_CENTRAL_SOURCE_SHA,
  createFleetP7GitHubReadbackAdapter,
} from "@/lib/control-plane/fleet-p7-github-readback";
import type { FleetGitHubAppPublicSource } from "@/lib/github/app";

const CENTRAL_SHA = FLEET_P7_CENTRAL_SOURCE_SHA;

function encoded(content: string) {
  return {
    data: {
      type: "file",
      encoding: "base64",
      content: Buffer.from(content).toString("base64"),
      size: Buffer.byteLength(content),
    },
  };
}

function appSource(): FleetGitHubAppPublicSource {
  return {
    observedAt: "2026-08-31T08:00:00.000Z",
    app: {
      id: "4124446",
      slug: "seorilabs-backoffice",
      ownerId: "283115031",
      ownerLogin: "seorilabs",
      active: true,
      webhookActive: true,
      webhookUrl: "https://backoffice.vzyx.xyz/api/webhooks",
      permissions: { contents: "write", metadata: "read" },
      events: ["push", "repository"],
    },
    installation: {
      installationId: "142120077",
      appId: "4124446",
      targetId: "283115031",
      targetType: "Organization",
      accountLogin: "seorilabs",
      repositorySelection: "all",
      permissions: { contents: "write", metadata: "read" },
      events: ["push", "repository"],
      suspended: false,
      updatedAt: "2026-08-31T07:00:00.000Z",
      suspendedAt: null,
    },
  };
}

function inventory() {
  return {
    repositories: [
      {
        repository: {
          id: "1250442131",
          fullName: "seorilabs/happy-farm",
          sourceSha: "b".repeat(40),
          private: true,
          classification: "PRODUCT_APP",
        },
      },
      {
        repository: {
          id: "1265192029",
          fullName: "seorilabs/lizard-tycoon",
          sourceSha: "c".repeat(40),
          private: true,
          classification: "PRODUCT_APP",
        },
      },
    ],
  };
}

test("GitHub adapter가 central HEAD와 공개 P7 provider readback만 결합한다", async () => {
  const contract = [
    "schemaVersion: 3",
    "github:",
    "  ruleset:",
    "    repositories: [happy-farm, lizard-tycoon]",
    "",
  ].join("\n");
  const request = async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repositories/{repository_id}") {
      return { data: { id: 1241442018, full_name: "seorilabs/.github", default_branch: "main", archived: false } };
    }
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      return { data: { object: { sha: CENTRAL_SHA } } };
    }
    if (route === "GET /orgs/{org}/properties/schema") {
      return { data: [{ property_name: "fleet-managed", value_type: "single_select", required: false }] };
    }
    if (route === "GET /orgs/{org}/rulesets") {
      return { data: [{ id: 77 }] };
    }
    if (route === "GET /orgs/{org}/rulesets/{ruleset_id}") {
      return {
        data: {
          id: 77,
          name: "Fleet Org Contract shadow",
          target: "branch",
          enforcement: "evaluate",
          conditions: { repository_id: { repository_ids: [1250442131, 1265192029] } },
          rules: [{
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "Org Contract / Org Contract" }] },
          }],
        },
      };
    }
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      if (parameters.repo === ".github") return encoded(contract);
      return encoded("name: Org Contract\n");
    }
    throw new Error(`unexpected route ${route}`);
  };
  const adapter = createFleetP7GitHubReadbackAdapter({
    client: { request } as never,
    readAppSource: async () => appSource(),
  });
  const result = await adapter.read(inventory());
  assert.equal(result.currentCentralSourceSha, CENTRAL_SHA);
  assert.equal(result.installation?.app_id, 4124446);
  assert.deepEqual(result.defaultBranchOrgContractCallers, [
    { fullName: "seorilabs/happy-farm" },
    { fullName: "seorilabs/lizard-tycoon" },
  ]);
  assert.deepEqual(result.rulesets?.[0], {
    id: 77,
    name: "Fleet Org Contract shadow",
    target: "branch",
    enforcement: "evaluate",
    requiredStatusChecks: ["Org Contract / Org Contract"],
    repositories: ["seorilabs/happy-farm", "seorilabs/lizard-tycoon"],
  });
});

test("optional GitHub readback 권한이 없으면 부재로 꾸미지 않고 null로 닫는다", async () => {
  const request = async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repositories/{repository_id}") {
      return { data: { id: 1241442018, full_name: "seorilabs/.github", default_branch: "main", archived: false } };
    }
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      return { data: { object: { sha: CENTRAL_SHA } } };
    }
    if (route === "GET /repos/{owner}/{repo}/contents/{path}" && parameters.repo === ".github") {
      return encoded("schemaVersion: 3\ngithub:\n  ruleset:\n    repositories: [happy-farm]\n");
    }
    const error = new Error("forbidden") as Error & { status: number };
    error.status = 403;
    throw error;
  };
  const adapter = createFleetP7GitHubReadbackAdapter({
    client: { request } as never,
    readAppSource: async () => { throw new Error("unavailable"); },
  });
  const result = await adapter.read(inventory());
  assert.equal(result.currentCentralSourceSha, CENTRAL_SHA);
  assert.equal(result.installation, null);
  assert.equal(result.organizationCustomProperties, null);
  assert.equal(result.rulesets, null);
  assert.equal(result.defaultBranchOrgContractCallers, null);
});

test("live central HEAD가 pinned repo-contract source와 다르면 fail-closed한다", async () => {
  const request = async (route: string) => {
    if (route === "GET /repositories/{repository_id}") {
      return { data: { id: 1241442018, full_name: "seorilabs/.github", default_branch: "main", archived: false } };
    }
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      return { data: { object: { sha: "f".repeat(40) } } };
    }
    throw new Error(`unexpected route ${route}`);
  };
  const adapter = createFleetP7GitHubReadbackAdapter({
    client: { request } as never,
    readAppSource: async () => appSource(),
  });
  await assert.rejects(adapter.read(inventory()), /FLEET_P7_CENTRAL_SOURCE_DRIFT/u);
});
