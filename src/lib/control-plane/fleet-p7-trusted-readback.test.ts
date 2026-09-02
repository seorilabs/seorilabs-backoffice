import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createFleetP7TrustedAggregateReadback } from "@/lib/control-plane/fleet-p7-trusted-readback";

const NOW = new Date("2026-08-31T08:00:00.000Z");
const CENTRAL_SHA = "a".repeat(40);
const { publicKey } = generateKeyPairSync("ed25519");

function fixtureIssuance() {
  return {
    inventory: {
      inventoryId: "fleet-inventory-0001",
      repositories: [
        {
          repository: {
            id: "101",
            fullName: "seorilabs/private-app",
            sourceSha: "b".repeat(40),
            private: true,
            classification: "PRODUCT_APP",
          },
          candidates: [],
        },
        {
          repository: {
            id: "102",
            fullName: "seorilabs/public-app",
            sourceSha: "c".repeat(40),
            private: false,
            classification: "PRODUCT_APP",
          },
          candidates: [],
        },
        {
          repository: {
            id: "103",
            fullName: "seorilabs/public-infra",
            sourceSha: "d".repeat(40),
            private: false,
            classification: "INFRA_REPO",
          },
          candidates: [],
        },
      ],
    },
  };
}

test("trusted binding에서 current central SHA caller readback과 P7 aggregate를 만든다", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await createFleetP7TrustedAggregateReadback({
    issuance: fixtureIssuance(),
    publicKey,
    now: NOW,
    loadBinding: (input) => {
      calls.push(input);
      return { inventoryDigest: `sha256:${"1".repeat(64)}` };
    },
    createCallerReadback: (input) => {
      calls.push(input);
      return {
        contract: "seorilabs-fleet-caller-migration-readback-v1",
        currentCentralSourceSha: input.currentCentralSourceSha,
      };
    },
    readGitHub: async () => ({
      currentCentralSourceSha: CENTRAL_SHA,
      centralContract: { sourceSha: CENTRAL_SHA, schemaVersion: 4, contentDigest: "sha256:" + "1".repeat(64) },
      installation: { app_id: 4124446 },
      organizationCustomProperties: [],
      protection: { providerMode: "REPO_BRANCH_PROTECTION", rolloutMode: "SHADOW", observationMode: "READ_ONLY",
        existingProtectionChanged: false, activationAllowed: false, repositories: [], ready: false },
      defaultBranchOrgContractCallers: [],
    }),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.currentCentralSourceSha, CENTRAL_SHA);
  assert.equal(result.callerMigration.currentCentralSourceSha, CENTRAL_SHA);
  assert.equal(result.cloudBuildBindings, null);
  assert.equal(result.protection?.activationAllowed, false);
  assert.equal(result.centralContract.sourceSha, CENTRAL_SHA);
  assert.equal(Object.hasOwn(result, "rulesets"), false);
  assert.deepEqual(result.publicRepositories, [
    { fullName: "seorilabs/public-app", requiresRelease: true },
    { fullName: "seorilabs/public-infra", requiresRelease: false },
  ]);
});

test("aggregate 공개 readback에 private surface가 섞이면 거부한다", async () => {
  await assert.rejects(
    createFleetP7TrustedAggregateReadback({
      issuance: fixtureIssuance(),
      publicKey,
      now: NOW,
      loadBinding: () => ({}),
      createCallerReadback: () => ({ contract: "caller-readback" }),
      readGitHub: async () => ({
        currentCentralSourceSha: CENTRAL_SHA,
        centralContract: { sourceSha: CENTRAL_SHA, schemaVersion: 4, contentDigest: "sha256:" + "1".repeat(64) },
        installation: { token: "forbidden" },
        organizationCustomProperties: null,
        protection: null,
        defaultBranchOrgContractCallers: null,
      }),
    }),
    /FLEET_P7_TRUSTED_READBACK_PRIVATE_SURFACE_REJECTED/u,
  );
});

test("pinned repo-contract가 trusted binding과 caller projection API를 함께 공급한다", async () => {
  const contract = await import("seorilabs-org-contracts/repo-contract/fleet-migration");
  assert.equal(typeof contract.loadTrustedFleetMigrationInventoryBinding, "function");
  assert.equal(typeof contract.createFleetCallerMigrationReadback, "function");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.match(
    packageJson.dependencies["seorilabs-org-contracts"],
    /^github:seorilabs\/\.github#[a-f0-9]{40}$/u,
  );
  const settings = await import("seorilabs-org-contracts/repo-contract/github-settings-readback");
  assert.equal(typeof settings.githubProtectionReadback, "function");
});
