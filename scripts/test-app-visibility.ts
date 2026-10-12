import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { setAppVisibility } from "@/lib/control-plane/app-visibility-service";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { PLATFORM_OUTCOME_UNKNOWN_CODE } from "@/lib/platform/operations";

const url = new URL(process.env.DATABASE_URL ?? "");
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/backoffice_iap_qa') {
  throw new Error('ISOLATED_DATABASE_REQUIRED');
}

async function main() {
  const prefix = `qa-visibility-${Date.now()}`;
  const admin = await prisma.user.create({data: {login: `${prefix}-admin`, githubId: BigInt(Date.now()), role: 'ADMIN', allowlisted: true}});
  const maintainer = await prisma.user.create({data: {login: `${prefix}-owner`, githubId: BigInt(Date.now()) + 1n, role: 'MAINTAINER', allowlisted: true}});
  const other = await prisma.user.create({data: {login: `${prefix}-other`, githubId: BigInt(Date.now()) + 2n, role: 'MAINTAINER', allowlisted: true}});
  const createApp = (suffix: string) => prisma.app.create({data: {
    id: `${prefix}-${suffix}`, slug: `${prefix}-${suffix}`, repoFullName: `qa/${prefix}-${suffix}`,
    displayName: suffix, type: 'GAME', engine: 'GODOT', marketTargets: [],
  }});
  const app = await createApp('target');
  const retained = await createApp('retained');
  await prisma.appOwner.create({data: {appId: app.id, userId: maintainer.id}});
  const revision = await prisma.configRevision.create({data: {
    appId: app.id, revision: 1, status: 'DRAFT', payload: {schemaVersion: 1, markets: []},
    payloadHash: 'a'.repeat(64), createdBy: admin.login, idempotencyKey: prefix,
  }});
  const request = {appId: app.id, expectedUpdatedAt: app.updatedAt.toISOString(), status: 'DEPRECATED' as const,
    reason: '격리 DB 카드 숨김 검증', requestId: prefix, actor: {kind: 'user' as const, login: maintainer.login}};
  await assert.rejects(setAppVisibility({...request, actor: {kind: 'user', login: other.login}}), /권한/);
  await assert.rejects(setAppVisibility({...request, expectedUpdatedAt: '2000-01-01T00:00:00.000Z'}), /최신/);
  const blocker = await prisma.appOperationRun.create({data: {
    appId: app.id, repoFullName: app.repoFullName, operation: 'qa.readback', intent: 'read', requestId: `${prefix}-blocker`,
    status: 'PROCESSING', expiresAt: new Date(Date.now() + 60000),
  }});
  await assert.rejects(setAppVisibility(request), /진행 중/);
  assert.equal(await prisma.auditLog.count({where: {action: 'app.visibility', entityId: app.id}}), 0);
  assert.equal((await prisma.app.findUniqueOrThrow({where: {id: app.id}})).status, 'ACTIVE');
  await prisma.appOperationRun.update({where: {id: blocker.id}, data: {status: 'FAILED', error: PLATFORM_OUTCOME_UNKNOWN_CODE}});
  await assert.rejects(setAppVisibility(request), /진행 중/);
  await prisma.appOperationRun.update({where: {id: blocker.id}, data: {status: 'SUCCEEDED', error: null}});
  const pendingCommand = await prisma.operatorCommandRun.create({data: {
    appId: app.id, sourceInteractionId: `${prefix}-command`, operation: 'qa.no-external-execution',
    actorDiscordUserId: 'qa', actorLabel: 'QA', channelId: 'qa', status: 'PENDING',
    expiresAt: new Date(Date.now() + 60000),
  }});
  for (const status of ['PENDING', 'PROCESSING'] as const) {
    await prisma.operatorCommandRun.update({where: {id: pendingCommand.id}, data: {status}});
    await assert.rejects(setAppVisibility(request), /진행 중/);
  }
  await prisma.operatorCommandRun.update({where: {id: pendingCommand.id}, data: {status: 'CANCELLED'}});
  const definition = await prisma.automationDefinition.create({data: {key: `${prefix}-agent`, appId: app.id, template: 'qa', enabled: false}});
  const occurrence = await prisma.automationOccurrence.create({data: {definitionId: definition.id, scheduledFor: new Date(), idempotencyKey: `${prefix}-occurrence`}});
  const pendingAgent = await prisma.agentRun.create({data: {appId: app.id, occurrenceId: occurrence.id, repoFullName: app.repoFullName, labels: [], status: 'PENDING'}});
  for (const status of ['PENDING', 'RUNNING'] as const) {
    await prisma.agentRun.update({where: {id: pendingAgent.id}, data: {status}});
    await assert.rejects(setAppVisibility(request), /진행 중/);
  }
  await prisma.agentRun.update({where: {id: pendingAgent.id}, data: {status: 'CANCELLED'}});
  const provider = await prisma.providerExecution.create({data: {
    appId: app.id, repoId: 999000001n, repoFullName: app.repoFullName, sourceSha: 'a'.repeat(40),
    configRevisionId: revision.id, configRevisionNumber: 1, kind: 'BLUEPRINT_RESOURCE', operation: 'APPLY',
    actionClass: 'DETERMINISTIC_MUTATION', provider: 'QA', resourceType: 'qa', resourceId: prefix,
    desiredHash: 'a'.repeat(64), desiredPayload: {}, publicAccountId: 'qa', credentialPublicIdentity: 'qa',
    logicalCredentialId: 'qa-only', credentialGeneration: 1, policyGeneration: 1, capability: 'qa',
    adapterId: 'qa', origin: 'http://127.0.0.1', environment: 'qa', authFactors: {},
    readbackPublicAccountId: 'qa', readbackCredentialPublicIdentity: 'qa', readbackLogicalCredentialId: 'qa-only',
    readbackCredentialGeneration: 1, readbackPolicyGeneration: 1, readbackCapability: 'qa', readbackAdapterId: 'qa',
    readbackOrigin: 'http://127.0.0.1', readbackEnvironment: 'qa', readbackAuthFactors: {},
    bindingHash: 'a'.repeat(64), requestHash: 'a'.repeat(64), idempotencyKey: `${prefix}-provider`,
  }});
  for (const status of ['QUEUED', 'WAITING_HUMAN_APPROVAL', 'RUNNING', 'READBACK_REQUIRED'] as const) {
    await prisma.providerExecution.update({where: {id: provider.id}, data: {status}});
    await assert.rejects(setAppVisibility(request), /진행 중/);
  }
  await prisma.providerExecution.update({where: {id: provider.id}, data: {status: 'CANCELLED', activeScopeKey: null}});
  assert.equal(await prisma.auditLog.count({where: {action: 'app.visibility', entityId: app.id}}), 0);
  assert.equal((await prisma.app.findUniqueOrThrow({where: {id: app.id}})).status, 'ACTIVE');
  const repeated = await Promise.all([setAppVisibility(request), setAppVisibility(request)]);
  assert.deepEqual(repeated.map((result) => result.duplicate).sort(), [false, true]);
  assert.deepEqual(repeated[0].response, repeated[1].response);
  assert.equal(await prisma.auditLog.count({where: {action: 'app.visibility', entityId: app.id}}), 1);
  assert.equal(await prisma.app.count({where: {id: app.id, ...visibleAppWhere}}), 0);
  assert.equal(await prisma.app.count({where: {id: retained.id, ...visibleAppWhere}}), 1);
  assert.deepEqual(await prisma.configRevision.findUniqueOrThrow({where: {id: revision.id}}), revision);
  assert.equal(await prisma.appOperationRun.count({where: {id: blocker.id}}), 1);
  await assert.rejects(setAppVisibility({...request, reason: '다른 내용'}), /동일 요청 ID/);
  // 재처리에도 현재 권한을 적용한다.
  await prisma.user.update({where: {id: maintainer.id}, data: {allowlisted: false}});
  await assert.rejects(setAppVisibility(request), /권한/);
  const hidden = await prisma.app.findUniqueOrThrow({where: {id: app.id}});
  const restored = await setAppVisibility({...request, expectedUpdatedAt: hidden.updatedAt.toISOString(), status: 'PAUSED',
    requestId: `${prefix}-restore`, actor: {kind: 'user', login: admin.login}});
  assert.equal(restored.duplicate, false);
  assert.equal((await prisma.app.findUniqueOrThrow({where: {id: app.id}})).status, 'PAUSED');
  assert.equal(await prisma.auditLog.count({where: {action: 'app.visibility', entityId: app.id}}), 2);
  console.log('PASS: MySQL 권한·버전·진행 중 실행·동시 중복·충돌·감사 원자성·이력 보존·복구');
}

main().finally(() => prisma.$disconnect()).catch((error) => { console.error(error); process.exitCode = 1; });
