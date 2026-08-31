import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(
  new URL("../../app/api/internal/fleet-migration/cleanup-capabilities/route.ts", import.meta.url),
  "utf8",
);
const service = readFileSync(new URL("./fleet-cleanup-service.ts", import.meta.url), "utf8");

test("EXECUTE route는 capability-bound idempotency와 GitHub OIDC만 소비한다", () => {
  assert.match(route, /fleet-cleanup-execute:\$\{body\.capabilityId\}/u);
  assert.match(route, /authenticateFleetCleanupGithubActionsRequest/u);
  assert.doesNotMatch(route, /authenticateInternalRequest\(request, "agent-adapter"\)|verifyAndConsumeAgentAdapterAttestation/u);
});

test("response outer는 scope/repo/action digest와 inner receipt를 공개 결합한다", () => {
  for (const field of [
    "seorilabs-fleet-cleanup-execution-response-v1",
    "capabilityId",
    "approvalScopeDigest",
    "organizationId",
    "installationId",
    "issuanceDigest",
    "inventoryDigest",
    "planDigest",
    "receiptDigest",
    "actionScope",
    "fileActionSetDigest",
    "replacementFilesDigest",
    "receipt",
  ]) assert.match(service, new RegExp(field, "u"));
});
