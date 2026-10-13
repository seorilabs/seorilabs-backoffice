import { readFile, lstat } from 'node:fs/promises';
import { prisma } from '../../src/lib/prisma';
import { withConsoleCollectionLock } from '../../src/lib/analytics/console-sync/collect';
import { consoleRuntimeLedger } from '../../src/lib/control-plane/console-oauth-runtime';
import { ConsoleOAuth, ConsoleSyncError, consoleErrorCode, TOKEN_URL } from '../../src/lib/analytics/console-sync/oauth';
import { assertExactVersion, storedConsoleGrantSchema, type ConsoleGrantVersions } from '../../src/lib/analytics/console-sync/versions';
import { createConsoleReader } from '../../src/lib/analytics/console-sync/client';
import { McpConsoleMetricsSource } from '../../src/lib/analytics/console-sync/source';
async function main() {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (process.env.NODE_ENV === 'production' || !/^bo-console-v2-[a-f0-9]{8}$/.test(url.hostname) || url.pathname !== '/backoffice_console_qa' || process.env.QA_CONSOLE_STORE_URL !== 'http://bo-console-store-01a1302c:8090')
        throw new ConsoleSyncError('ISOLATED_DATABASE_REQUIRED');
    const file = '/qa-auth/gateway.key', s = await lstat(file);
    if (!s.isFile() || (s.mode & 0o077))
        throw new ConsoleSyncError('OAUTH_FILE_NOT_PRIVATE');
    const key = await readFile(file, 'utf8');
    const request = async (path: string, method = 'GET', data?: unknown) => { const r = await fetch(`${process.env.QA_CONSOLE_STORE_URL}${path}`, { method, redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(30000) }); if (!r.ok)
        throw new ConsoleSyncError('OAUTH_QA_STORE_UNAVAILABLE'); return r.json(); };
    const versions: ConsoleGrantVersions = { read: async (version) => { assertExactVersion(version); return storedConsoleGrantSchema.parse(await request(`/versions/${version.split('/').at(-1)}`)); }, add: async (grant) => { const r = await request('/versions', 'POST', grant); assertExactVersion(r.version); return r.version; } };
    const mode = process.argv[2] ?? 'verify';
    if (!['verify', 'verify-refresh'].includes(mode))
        throw new ConsoleSyncError('CONSOLE_MODE_INVALID');
    const result = await withConsoleCollectionLock(async (assertHeld) => {
        const runtime = consoleRuntimeLedger({ kind: 'worker', principal: process.env.AIT_CONSOLE_RUNTIME_PRINCIPAL ?? '', workspaceId: 38345 }, assertHeld);
        const before = await runtime.read();
        const previous = await versions.read(before.secretVersion);
        const expiredBeforeQuery = previous.expiresAt <= Date.now();
        let refreshes = 0;
        const providerStatuses: number[] = [];
        const oauth = await ConsoleOAuth.open(versions, runtime, async (input, init) => { const r = await fetch(input, init); if (input === TOKEN_URL) {
            refreshes++;
            providerStatuses.push(r.status);
        } return r; });
        if (mode === 'verify-refresh')
            await oauth.refresh();
        const reader = await createConsoleReader(oauth);
        try {
            const source = new McpConsoleMetricsSource(reader);
            await source.verifyWorkspace();
            const metrics = await source.queryListing({ slug: 'happy-farm', workspaceId: 38345, miniAppId: 31877 }, '2026-10-12', '2026-10-12');
            const after = await runtime.read(), current = await versions.read(after.secretVersion);
            return { state: 'authenticated', mode, podName: process.env.HOSTNAME, generationBefore: before.generation, generationAfter: after.generation, phase: after.phase, previousExpiresAt: previous.expiresAt, currentExpiresAt: current.expiresAt, expiredBeforeQuery, refreshes, providerStatuses, rotated: previous.refreshToken !== current.refreshToken, secretVersion: after.secretVersion, metricDays: metrics.days.length, missing: metrics.missing, errors: metrics.errors };
        }
        finally {
            await reader.close();
        }
    });
    console.log(JSON.stringify(result));
}
main().catch(e => { console.error(JSON.stringify({ state: 'failed', code: consoleErrorCode(e) })); process.exitCode = 1; }).finally(() => prisma.$disconnect());
