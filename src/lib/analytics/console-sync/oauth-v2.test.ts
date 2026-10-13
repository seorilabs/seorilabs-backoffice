import assert from 'node:assert/strict';
import test from 'node:test';
import { ConsoleOAuth, MCP_URL, TOKEN_URL, consoleErrorCode } from './oauth';
import { fixtureConsoleRuntime } from '../../../../scripts/console-metrics/oauth-fixture';
const credential = { credentialId: 'shared/apps-in-toss/console-oauth' as const, clientId: 'mcp-gateway' as const, refreshToken: 'old' };
const response = () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'bearer', expires_in: 3600 });
test('v2 회전 refresh는 보존·버전 재조회·ACTIVE 확인 뒤에만 MCP를 계속한다', async () => {
    const f = fixtureConsoleRuntime(credential);
    let refreshes = 0;
    const oauth = await ConsoleOAuth.open(f.versions, f.runtime, async (url, init) => {
        if (url === TOKEN_URL) {
            refreshes++;
            assert.equal(f.state().phase, 'REFRESH_IN_FLIGHT');
            f.events.push('provider');
            return response();
        }
        assert.equal(f.state().phase, 'ACTIVE');
        assert.equal(f.state().generation, 2);
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer new-access');
        f.events.push('mcp');
        return Response.json({ ok: true });
    });
    await Promise.all([oauth.fetch(MCP_URL), oauth.fetch(MCP_URL)]);
    assert.equal(refreshes, 1);
    assert.ok(f.events.indexOf('begin') < f.events.indexOf('provider'));
    assert.ok(f.events.indexOf('add') < f.events.indexOf('complete'));
    assert.ok(f.events.indexOf('complete') < f.events.indexOf('mcp'));
    const saved = await f.versions.read(f.state().secretVersion);
    assert.equal(saved.refreshToken, 'new-refresh');
    await (await ConsoleOAuth.open(f.versions, f.runtime, async (url) => { assert.notEqual(url, TOKEN_URL); return Response.json({ ok: true }); })).fetch(MCP_URL);
});
test('갱신 중 상태 보존/잠금 실패는 provider 전송 0회다', async () => {
    for (const failure of ['begin', 'lease'] as const) {
        const f = fixtureConsoleRuntime(credential);
        let calls = 0;
        const oauth = await ConsoleOAuth.open(f.versions, f.runtime, async () => { calls++; return response(); });
        f.faults[failure] = true;
        await assert.rejects(oauth.refresh(), /OAUTH_STATE_PRESERVATION_FAILED/);
        assert.equal(calls, 0);
    }
});
test('provider 발급 뒤 저장·재조회·CAS 장애는 영속 IN_FLIGHT이며 재시작도 옛 grant를 재전송하지 않는다', async () => {
    for (const failure of ['add', 'read', 'complete', 'lease'] as const) {
        const f = fixtureConsoleRuntime(credential);
        let calls = 0;
        const oauth = await ConsoleOAuth.open(f.versions, f.runtime, async () => { calls++; f.faults[failure] = true; return response(); });
        await assert.rejects(oauth.refresh(), /OAUTH_GRANT_PRESERVATION_FAILED/);
        assert.equal(f.state().phase, 'REFRESH_IN_FLIGHT');
        if (failure === 'lease') assert.equal(f.grants.size, 2, '발급 뒤 잠금 손실에도 새 grant는 orphan 불변 버전으로 보존');
        await assert.rejects(oauth.refresh());
        f.faults.lease = false;
        await assert.rejects(ConsoleOAuth.open(f.versions, f.runtime, async () => { calls++; return response(); }), /OAUTH_REFRESH_IN_FLIGHT/);
        assert.equal(calls, 1);
    }
});
test('불완전 응답·전송 결과 불명·HTTP 오류는 새 실행에서도 IN_FLIGHT 차단한다', async () => {
    for (const fetcher of [async () => Response.json({ access_token: 'new', refresh_token: 'new-refresh' }), async () => { throw Error('synthetic-secret'); }, async () => Response.json({ error: 'invalid_grant', description: 'synthetic-secret' }, { status: 400 }), async () => new Response(null, { status: 503 })]) {
        const f = fixtureConsoleRuntime(credential);
        let calls = 0;
        const oauth = await ConsoleOAuth.open(f.versions, f.runtime, async () => { calls++; return fetcher(); });
        try {
            await oauth.refresh();
            assert.fail('refresh must stop');
        }
        catch (e) {
            assert.ok(!JSON.stringify(e).includes('synthetic-secret'));
            assert.notEqual(consoleErrorCode(e), 'CONSOLE_REQUEST_FAILED');
        }
        await assert.rejects(ConsoleOAuth.open(f.versions, f.runtime), /OAUTH_REFRESH_IN_FLIGHT/);
        assert.equal(calls, 1);
    }
});
test('오래된 인스턴스·잘못된 payload generation·외부 URL은 호출 전에 중단한다', async () => {
    const f = fixtureConsoleRuntime(credential);
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return response(); };
    const first = await ConsoleOAuth.open(f.versions, f.runtime, fetcher), old = await ConsoleOAuth.open(f.versions, f.runtime, fetcher);
    await first.refresh();
    await assert.rejects(old.refresh(), /OAUTH_STATE_PRESERVATION_FAILED/);
    assert.equal(calls, 1);
    const grant = f.grants.get(f.state().secretVersion)!;
    grant.generation--;
    await assert.rejects(ConsoleOAuth.open(f.versions, f.runtime), /OAUTH_GENERATION_MISMATCH/);
    await assert.rejects(first.fetch('https://example.com'), /MCP_HOST_NOT_ALLOWED/);
    assert.equal(calls, 1);
});
test('비회전 응답도 새 불변 버전과 generation 증가를 확인한다', async () => {
    const f = fixtureConsoleRuntime(credential);
    const oauth = await ConsoleOAuth.open(f.versions, f.runtime, async () => Response.json({ access_token: 'new', refresh_token: 'old', token_type: 'bearer', expires_in: 3600 }));
    const old = f.state().secretVersion;
    await oauth.refresh();
    assert.equal(f.state().generation, 2);
    assert.notEqual(f.state().secretVersion, old);
    assert.equal((await f.versions.read(f.state().secretVersion)).refreshToken, 'old');
});
test('유효한 access token이 있어도 진행 중인 갱신의 보존을 기다린 뒤 MCP를 조회한다', async () => {
    const f = fixtureConsoleRuntime({ ...credential, accessToken: 'still-valid', expiresAt: Date.now() + 3600000 });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
    let reads = 0;
    const oauth = await ConsoleOAuth.open(f.versions, f.runtime, async (url) => { if (url === TOKEN_URL) {
        entered();
        await held;
        return response();
    } reads++; assert.equal(f.state().phase, 'ACTIVE'); assert.equal(f.state().generation, 2); return Response.json({ ok: true }); });
    const refresh = oauth.refresh();
    await started;
    const read = oauth.fetch(MCP_URL);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(reads, 0);
    release();
    await Promise.all([refresh, read]);
    assert.equal(reads, 1);
});
