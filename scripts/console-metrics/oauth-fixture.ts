import { ConsoleOAuth, ConsoleSyncError, type ConsoleCredential } from '../../src/lib/analytics/console-sync/oauth';
import { CONSOLE_CREDENTIAL_ID, type ConsoleRuntimeLedger, type ConsoleRuntimeState } from '../../src/lib/analytics/console-sync/runtime';
import type { ConsoleGrantVersions, StoredConsoleGrant } from '../../src/lib/analytics/console-sync/versions';
// 합성 테스트 전용 메모리 저장소. 운영 수집기에 연결하지 않는다.
export function fixtureConsoleRuntime(credential: ConsoleCredential) {
    let sequence = 1;
    const first = 'local/versions/00000000-0000-4000-8000-000000000001';
    let state: ConsoleRuntimeState = { credentialId: CONSOLE_CREDENTIAL_ID, generation: 1, phase: 'ACTIVE', secretVersion: first, attemptId: null };
    const grants = new Map<string, StoredConsoleGrant>([[first, { ...credential, generation: 1, accessToken: credential.accessToken ?? 'expired', expiresAt: credential.expiresAt ?? 1 }]]);
    const events: string[] = [];
    const faults = { lease: false, begin: false, add: false, read: false, complete: false };
    const versions: ConsoleGrantVersions = { read: async (v) => { events.push(`read:${v}`); if (faults.read || !grants.has(v))
            throw Error('synthetic-secret'); return { ...grants.get(v)! }; }, add: async (g) => { events.push('add'); if (faults.add)
            throw Error('synthetic-secret'); const v = `local/versions/00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`; grants.set(v, { ...g }); return v; } };
    const same = (expected: ConsoleRuntimeState) => { if (JSON.stringify(state) !== JSON.stringify(expected))
        throw new ConsoleSyncError('OAUTH_STATE_CONFLICT'); };
    const runtime: ConsoleRuntimeLedger = { assertLease: async () => { if (faults.lease)
            throw new ConsoleSyncError('OAUTH_COLLECTION_LOCK_LOST'); }, read: async () => ({ ...state }), begin: async (expected, attemptId) => { events.push('begin'); same(expected); if (faults.begin)
            throw Error('synthetic-secret'); state = { ...state, phase: 'REFRESH_IN_FLIGHT', attemptId }; return { ...state }; }, complete: async (expected, secretVersion) => { events.push('complete'); same(expected); if (faults.complete)
            throw Error('synthetic-secret'); state = { ...state, phase: 'ACTIVE', generation: state.generation + 1, secretVersion, attemptId: null }; return { ...state }; } };
    return { versions, runtime, events, faults, grants, state: () => ({ ...state }), setState: (s: ConsoleRuntimeState) => { state = s; } };
}
export async function createFixtureOAuth(credential: ConsoleCredential, fetchFn: typeof fetch) { const f = fixtureConsoleRuntime(credential); return ConsoleOAuth.open(f.versions, f.runtime, fetchFn); }
