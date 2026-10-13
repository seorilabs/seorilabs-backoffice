import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { jsonDigest } from './json';
import { ConsoleSyncError } from '@/lib/analytics/console-sync/oauth';
import { CONSOLE_CREDENTIAL_ID, type ConsoleRuntimeState, type ConsoleRuntimeLedger } from '@/lib/analytics/console-sync/runtime';
const version = z.string().regex(/^(?:local\/versions\/[a-f0-9-]{36}|projects\/[1-9]\d*\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/[1-9]\d*)$/);
export const consoleRuntimeSnapshotSchema = z.object({ credentialId: z.literal(CONSOLE_CREDENTIAL_ID), generation: z.number().int().min(1), phase: z.enum(['ACTIVE', 'REFRESH_IN_FLIGHT']), secretVersion: version, attemptId: z.string().uuid().nullable() }).strict().refine(s => (s.phase === 'ACTIVE') === (s.attemptId === null));
export const consoleRuntimeMutationSchema = z.object({ operation: z.enum(['REGISTER', 'BEGIN', 'COMPLETE']), workspaceId: z.literal(38345), expected: consoleRuntimeSnapshotSchema.nullable(), secretVersion: version.optional(), attemptId: z.string().uuid().optional() }).strict();
export type ConsoleRuntimeActor = {
    kind: 'user';
    login: string;
} | {
    kind: 'worker';
    principal: string;
    workspaceId: 38345;
};
export function assertConsoleRuntimeWorker(actor: Extract<ConsoleRuntimeActor, {
    kind: 'worker';
}>) {
    if (actor.workspaceId !== 38345 || !process.env.AIT_CONSOLE_RUNTIME_PRINCIPAL || actor.principal !== process.env.AIT_CONSOLE_RUNTIME_PRINCIPAL)
        throw new ConsoleSyncError('OAUTH_RUNTIME_ACCESS_FORBIDDEN');
}
export function nextConsoleRuntimeState(input: z.infer<typeof consoleRuntimeMutationSchema>): ConsoleRuntimeState {
    const { expected, operation } = input;
    if (operation === 'REGISTER') {
        if (!input.secretVersion || input.attemptId || (expected && expected.secretVersion === input.secretVersion))
            throw new ConsoleSyncError('OAUTH_STATE_TRANSITION_INVALID');
        return { credentialId: CONSOLE_CREDENTIAL_ID, generation: (expected?.generation ?? 0) + 1, phase: 'ACTIVE', secretVersion: input.secretVersion, attemptId: null };
    }
    if (!expected)
        throw new ConsoleSyncError('OAUTH_STATE_TRANSITION_INVALID');
    if (operation === 'BEGIN') {
        if (expected.phase !== 'ACTIVE' || !input.attemptId || input.secretVersion)
            throw new ConsoleSyncError('OAUTH_STATE_TRANSITION_INVALID');
        return { ...expected, phase: 'REFRESH_IN_FLIGHT', attemptId: input.attemptId };
    }
    if (expected.phase !== 'REFRESH_IN_FLIGHT' || !input.secretVersion || input.secretVersion === expected.secretVersion || input.attemptId)
        throw new ConsoleSyncError('OAUTH_STATE_TRANSITION_INVALID');
    return { ...expected, generation: expected.generation + 1, phase: 'ACTIVE', secretVersion: input.secretVersion, attemptId: null };
}
function snapshot(row: unknown) { const result = consoleRuntimeSnapshotSchema.safeParse(row); if (!result.success)
    throw new ConsoleSyncError('OAUTH_RUNTIME_STATE_INVALID'); return result.data; }
export async function readConsoleRuntimeState(client: PrismaClient = prisma): Promise<ConsoleRuntimeState> {
    const row = await client.consoleOAuthRuntimeState.findUnique({ where: { credentialId: CONSOLE_CREDENTIAL_ID }, select: { credentialId: true, generation: true, phase: true, secretVersion: true, attemptId: true } });
    if (!row)
        throw new ConsoleSyncError('OAUTH_RUNTIME_NOT_REGISTERED');
    return snapshot(row);
}
// 공유 credential의 고정 workspace 범위만 조작하며 catalog / ConfigRevision은 변경하지 않는다.
export async function mutateConsoleRuntime(input: z.infer<typeof consoleRuntimeMutationSchema>, actor: ConsoleRuntimeActor, requestId: string, client: PrismaClient = prisma) {
    const parsed = consoleRuntimeMutationSchema.safeParse(input);
    if (!parsed.success)
        throw new ConsoleSyncError('OAUTH_RUNTIME_REQUEST_INVALID');
    const request = parsed.data;
    const desired = nextConsoleRuntimeState(request);
    if (!/^[A-Za-z0-9._:-]{8,191}$/.test(requestId))
        throw new ConsoleSyncError('OAUTH_RUNTIME_REQUEST_INVALID');
    const actorId = actor.kind === 'user' ? `user:${actor.login}` : actor.principal;
    if (actor.kind === 'worker') {
        assertConsoleRuntimeWorker(actor);
        if (request.operation === 'REGISTER')
            throw new ConsoleSyncError('OAUTH_RUNTIME_ACCESS_FORBIDDEN');
    }
    const operation = `console.oauth.${request.operation.toLowerCase()}`;
    const targetKey = CONSOLE_CREDENTIAL_ID;
    const requestHash = jsonDigest({ actor: actorId, operation, targetKey, request });
    try {
        return await client.$transaction(async (tx) => {
            if (actor.kind === 'user') {
                const user = await tx.user.findUnique({ where: { login: actor.login }, select: { role: true, allowlisted: true } });
                if (!user?.allowlisted || user.role !== 'ADMIN')
                    throw new ConsoleSyncError('OAUTH_RUNTIME_ACCESS_FORBIDDEN');
            }
            const replay = await tx.automationMutationRequest.findUnique({ where: { requestId } });
            if (replay) {
                if (replay.requestHash !== requestHash || replay.actor !== actorId || replay.operation !== operation || replay.targetKey !== targetKey || replay.status !== 'COMPLETED')
                    throw new ConsoleSyncError('OAUTH_IDEMPOTENCY_CONFLICT');
                return { duplicate: true, state: snapshot(replay.response) };
            }
            if (request.expected) {
                const result = await tx.consoleOAuthRuntimeState.updateMany({ where: request.expected, data: desired });
                if (result.count !== 1)
                    throw new ConsoleSyncError('OAUTH_STATE_CONFLICT');
            }
            else {
                if (request.operation !== 'REGISTER')
                    throw new ConsoleSyncError('OAUTH_STATE_TRANSITION_INVALID');
                await tx.consoleOAuthRuntimeState.create({ data: desired });
            }
            const confirmed = await tx.consoleOAuthRuntimeState.findUnique({ where: { credentialId: CONSOLE_CREDENTIAL_ID }, select: { credentialId: true, generation: true, phase: true, secretVersion: true, attemptId: true } });
            if (jsonDigest(snapshot(confirmed)) !== jsonDigest({ ...desired }))
                throw new ConsoleSyncError('OAUTH_STATE_READBACK_MISMATCH');
            await tx.automationMutationRequest.create({ data: { requestId, actor: actorId, operation, targetKey, requestHash, request, status: 'COMPLETED', response: desired as unknown as Prisma.InputJsonValue, completedAt: new Date() } });
            await tx.auditLog.create({ data: { actorLogin: actorId, action: operation, entityType: 'ConsoleOAuthRuntimeState', entityId: CONSOLE_CREDENTIAL_ID, payload: { requestId, ...desired } } });
            return { duplicate: false, state: desired };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    }
    catch (e) {
        if (e instanceof ConsoleSyncError)
            throw e;
        throw new ConsoleSyncError('OAUTH_STATE_PRESERVATION_FAILED');
    }
}
export function consoleRuntimeLedger(actor: Extract<ConsoleRuntimeActor, {
    kind: 'worker';
}>, assertLease: () => Promise<void>, client: PrismaClient = prisma): ConsoleRuntimeLedger {
    assertConsoleRuntimeWorker(actor);
    return { assertLease, read: () => readConsoleRuntimeState(client), begin: async (expected, attemptId) => {
            await assertLease();
            return (await mutateConsoleRuntime({ operation: 'BEGIN', workspaceId: 38345, expected, attemptId }, actor, `${attemptId}:begin`, client)).state;
        }, complete: async (expected, secretVersion) => {
            await assertLease();
            return (await mutateConsoleRuntime({ operation: 'COMPLETE', workspaceId: 38345, expected, secretVersion }, actor, `${expected.attemptId}:complete`, client)).state;
        } };
}
