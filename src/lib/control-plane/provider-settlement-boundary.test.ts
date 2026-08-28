import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  containsWorkerSuppliedObservation,
  providerSignerSettlementRequestSchema,
} from "@/lib/control-plane/provider-settlement-request";
import {
  buildAuthBrokerPolicyGrant,
  parseTrustedBrokerObservation,
} from "@/lib/control-plane/provider-adapter-client";
import { compileProviderCommandEnvelope } from "@/lib/control-plane/provider-execution";
import type { ProviderCommandEnvelope } from "@/lib/control-plane/contracts";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const subject = "k8s:platform:provider-execution-worker";

function readbackEnvelope(): ProviderCommandEnvelope {
  return compileProviderCommandEnvelope({
    executionId: "provider-execution-1",
    generation: 2,
    resumeMode: "READBACK_FIRST",
    operation: "READBACK",
    provider: "google-play",
    repoId: 123n,
    repoFullName: "seorilabs/sample-app",
    sourceSha: "a".repeat(40),
    configRevision: 2,
    desiredHash: "b".repeat(64),
    desired: {
      market: "google-play",
      publicAccountId: "publisher-team",
      publicAppId: "com.seorilabs.sample",
      artifactChecksum: "d".repeat(64),
    },
    resourceType: "market-release",
    resourceId: "com.seorilabs.sample",
    expectedPublicIdentity: "com.seorilabs.sample",
    artifactChecksum: "d".repeat(64),
    bindingHash: "c".repeat(64),
    credential: {
      logicalCredentialId: "shared/google-play/fleet-inventory",
      credentialGeneration: 5,
      policyGeneration: 7,
      capability: "google-play.readback",
      publicAccountId: "publisher-team",
      credentialPublicIdentity: "fleet-reader@seorilabs-gws.iam.gserviceaccount.com",
      adapterId: "google-play-api-v1",
      origin: "https://androidpublisher.googleapis.com",
      environment: "internal",
      authFactors: ["oidc"],
    },
    approval: {
      id: "provider-preapproval:provider-execution-1:2",
      mode: "preapproved",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
}

const validSettlement = {
  executionId: "provider-execution-1",
  generation: 2,
  outcome: "OBSERVED" as const,
  idempotencyKey: "provider-settlement:provider-execution-1:2",
};

test("settlement 요청 계약에는 worker가 관측을 넣을 자리가 없다", () => {
  assert.equal(providerSignerSettlementRequestSchema.safeParse(validSettlement).success, true);

  // valid worker identity와 claim이 있어도 관측 payload를 붙이면 계약 자체가 거부한다.
  for (const forged of [
    { observation: { kind: "MARKET", payload: {} } },
    { observationReceipt: { policyGrantId: "provider-grant-x-2" } },
    { leaseToken: "f".repeat(64) },
  ]) {
    const body = { ...validSettlement, ...forged };
    assert.equal(containsWorkerSuppliedObservation(body), true);
    assert.equal(providerSignerSettlementRequestSchema.safeParse(body).success, false);
  }
  assert.equal(containsWorkerSuppliedObservation(validSettlement), false);
  assert.equal(containsWorkerSuppliedObservation(null), false);
  assert.equal(containsWorkerSuppliedObservation([{ observation: 1 }]), false);
});

test("FAILED/APPROVAL_REQUIRED는 공개 error code 없이는 정착할 수 없다", () => {
  assert.equal(providerSignerSettlementRequestSchema.safeParse({
    ...validSettlement, outcome: "FAILED",
  }).success, false);
  assert.equal(providerSignerSettlementRequestSchema.safeParse({
    ...validSettlement, outcome: "FAILED", errorCode: "ADAPTER_FAILED",
  }).success, true);
  assert.equal(providerSignerSettlementRequestSchema.safeParse({
    ...validSettlement, outcome: "APPROVAL_REQUIRED",
  }).success, false);
});

test("broker 관측은 exact policy grant reference와 일치할 때만 신뢰 관측이 된다", () => {
  const envelope = readbackEnvelope();
  const built = buildAuthBrokerPolicyGrant(envelope, subject);
  const observation = {
    kind: "MARKET" as const,
    payload: {
      schemaVersion: 1,
      market: "google-play",
      publicAccountId: "publisher-team",
      publicAppId: "com.seorilabs.sample",
      gate: "PUBLIC",
      state: "LIVE",
      sourceSha: envelope.sourceSha,
      configRevision: 2,
      artifactChecksum: envelope.artifactChecksum!,
      observedAt: "2098-01-01T00:00:00.000Z",
    },
  };
  const policyGrant = {
    id: built.grant.id,
    digest: built.digest,
    bindingHash: built.grant.bindingHash,
    commandDigest: built.grant.commandDigest,
    policyGeneration: built.grant.policyGeneration,
    state: "ACTIVE" as const,
  };

  const trusted = parseTrustedBrokerObservation({ body: { policyGrant, observation }, envelope, subject });
  assert.equal(trusted.observation.kind, "MARKET");
  assert.deepEqual(trusted.receipt, {
    policyGrantId: built.grant.id,
    policyGrantDigest: built.digest,
    bindingHash: built.grant.bindingHash,
    commandDigest: built.grant.commandDigest,
    policyGeneration: built.grant.policyGeneration,
    generation: 2,
  });

  // grant reference를 한 필드라도 바꾸면 관측 자체가 만들어지지 않는다.
  for (const forged of [
    { digest: "9".repeat(64) },
    { bindingHash: "8".repeat(64) },
    { commandDigest: "7".repeat(64) },
    { policyGeneration: 8 },
    { id: "provider-grant-" + "0".repeat(40) + "-3" },
  ]) {
    assert.throws(
      () => parseTrustedBrokerObservation({
        body: { policyGrant: { ...policyGrant, ...forged }, observation },
        envelope,
        subject,
      }),
      /AUTH_BROKER_OBSERVATION_BINDING_MISMATCH/,
    );
  }
  // 관측만 있고 grant reference가 없는 응답도 거부한다.
  assert.throws(
    () => parseTrustedBrokerObservation({ body: { observation }, envelope, subject }),
    /AUTH_BROKER_OBSERVATION_BINDING_MISMATCH/,
  );
});

test("signer endpoint는 worker 관측을 DB 접근 전에 거부하고 관측을 직접 읽는다", () => {
  const signer = source("scripts/provider-execution-attestation-signer.ts");

  const rejectAt = signer.indexOf("worker_supplied_observation_rejected");
  const parseAt = signer.indexOf("providerSignerSettlementRequestSchema.parse(raw)");
  const settleAt = signer.indexOf("await settleProviderExecution(");
  assert.ok(rejectAt > 0 && parseAt > rejectAt, "관측 거부가 파싱보다 앞서야 한다");
  assert.ok(settleAt > parseAt, "거부 경로는 settlement 이전에 끝나야 한다");
  assert.match(signer, /containsWorkerSuppliedObservation\(raw\)/);

  // 관측은 signer가 broker에서 직접 읽은 값만 넘긴다.
  assert.match(signer, /trusted = await readObservation\(body\.executionId, body\.generation\)/);
  assert.match(signer, /observation: trusted\.observation, observationReceipt: trusted\.receipt/);
  assert.match(signer, /readTrustedBrokerObservation\(/);
  // worker는 OBSERVATION stage를 proxy로 호출할 수 없다.
  assert.match(signer, /providerBrokerStageSchema\.exclude\(\["OBSERVATION"\]\)/);
  assert.match(signer, /ordinal: z\.literal\(1\)/);
  // 관측이 아직 없으면 durable requeue로 넘겨 재시작에 안전하게 만든다.
  assert.match(signer, /PROVIDER_OBSERVATION_PENDING/);
  assert.match(signer, /PROVIDER_ATTESTATION_ALREADY_ISSUED/);

  // signer는 어떤 경로에서도 raw secret이나 receipt capability를 응답에 싣지 않는다.
  assert.doesNotMatch(signer, /respond\(response, \d+, \{ *(leaseToken|attestation|receipt)/);
  assert.match(signer, /respond\(response, 200, result\)/);
});

test("worker 경계 클라이언트와 worker는 관측 payload를 만들 수 없다", () => {
  const boundary = source("src/lib/control-plane/provider-execution-boundary-client.ts");
  assert.doesNotMatch(boundary, /observation\?:/);
  assert.match(boundary, /providerSignerSettlementRequestSchema\.parse\(input\)/);

  const worker = source("scripts/provider-execution-worker.ts");
  assert.doesNotMatch(worker, /readObservation|observation:/);
  assert.match(worker, /outcome: "OBSERVED"/);

  // adapter에는 worker가 부를 수 있는 관측 read 경로가 남아 있지 않다.
  const adapter = source("src/lib/control-plane/provider-adapter-client.ts");
  assert.doesNotMatch(adapter, /async readObservation\(/);
  assert.match(adapter, /export async function readTrustedBrokerObservation/);
});

test("service는 영수증이 execution binding과 일치할 때만 관측을 원장에 남긴다", () => {
  const service = source("src/lib/control-plane/provider-execution-service.ts");
  const receiptCheck = service.indexOf("PROVIDER_OBSERVATION_RECEIPT_MISMATCH");
  const observationCreate = service.indexOf("tx.providerObservation.create(");
  const gateAppend = service.indexOf("appendReleaseGateObservation({");
  assert.ok(receiptCheck > 0);
  assert.ok(receiptCheck < observationCreate, "영수증 검증이 관측 row 생성보다 앞서야 한다");
  assert.ok(observationCreate < gateAppend);

  for (const bound of [
    /receipt\.bindingHash !== execution\.bindingHash/,
    /receipt\.generation !== execution\.leaseGeneration/,
    /receipt\.policyGeneration !== execution\.policyGeneration/,
    /receipt\.policyGrantId !== `provider-grant-\$\{execution\.bindingHash\.slice\(0, 40\)\}-\$\{execution\.leaseGeneration\}`/,
    /receipt\.commandDigest !== expectedCommandDigest/,
  ]) assert.match(service, bound);

  // 영수증은 settlement hash에 들어가 replay가 다른 영수증으로 바뀌지 못한다.
  assert.match(service, /observationReceipt: input\.observationReceipt/);

  const ledger = source("src/lib/control-plane/release-ledger.ts");
  assert.match(ledger, /PROVIDER_POLICY_GRANT_BINDING_MISMATCH/);
  assert.match(ledger, /providerPolicyGrantId: origin\.policyGrantId/);
});
