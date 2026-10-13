import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConsoleGrantVersions, SecretManagerConsoleGrantVersions, crc32c, type StoredConsoleGrant } from './versions';
const grant: StoredConsoleGrant = { credentialId: 'shared/apps-in-toss/console-oauth', clientId: 'mcp-gateway', generation: 1, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 1791885011714 };
const resource = 'projects/123456/secrets/console-oauth';
test('로컬 불변 버전은 0600으로 보존·정확한 ID로 재조회하며 alias/권한 위반을 거부한다', async () => { const dir = await mkdtemp(join(tmpdir(), 'console-versions-')); try {
    await chmod(dir, 0o700);
    const store = await LocalConsoleGrantVersions.initialize(dir);
    const first = await store.add(grant);
    const second = await store.add({ ...grant, generation: 2 });
    assert.notEqual(first, second);
    assert.deepEqual(await store.read(first), grant);
    await assert.rejects(store.read('latest'));
    await assert.rejects(store.read('../credential.json'));
    const file = join(dir, `${first.split('/').at(-1)}.json`);
    const original = await readFile(file, 'utf8');
    assert.ok(!original.includes('synthetic-access'));
    assert.ok(!original.includes('synthetic-refresh'));
    await chmod(file, 0o644);
    await assert.rejects(store.read(first));
    assert.equal(await readFile(file, 'utf8'), original);
}
finally {
    await rm(dir, { recursive: true });
} });
test('Secret Manager는 checksum·정확한 resource/version을 검증하며 최신 버전 fallback·재시도가 없다', async () => {
    assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
    const bytes = Buffer.from(JSON.stringify(grant));
    let reads = 0;
    const store = new SecretManagerConsoleGrantVersions(resource, async (url, method, data) => { assert.ok(url.startsWith(`https://secretmanager.googleapis.com/v1/${resource}`)); if (method === 'POST') {
        const payload = (data as {
            payload: {
                data: string;
                dataCrc32c: string;
            };
        }).payload;
        assert.equal(payload.dataCrc32c, String(crc32c(Buffer.from(payload.data, 'base64'))));
        return { name: `${resource}/versions/7`, state: 'ENABLED', clientSpecifiedPayloadChecksum: true };
    } reads++; return { name: `${resource}/versions/7`, payload: { data: bytes.toString('base64'), dataCrc32c: String(crc32c(bytes)) } }; });
    const v = await store.add(grant);
    assert.deepEqual(await store.read(v), grant);
    await assert.rejects(store.read(`${resource}/versions/latest`));
    await assert.rejects(store.read('projects/999/secrets/other/versions/7'));
    assert.equal(reads, 1);
    for (const response of [{ name: v, payload: { data: bytes.toString('base64'), dataCrc32c: '0' } }, { name: `${resource}/versions/8`, payload: { data: bytes.toString('base64'), dataCrc32c: String(crc32c(bytes)) } }]) {
        await assert.rejects(new SecretManagerConsoleGrantVersions(resource, async () => response).read(v));
    }
    let writes = 0;
    await assert.rejects(new SecretManagerConsoleGrantVersions(resource, async () => { writes++; throw Error('synthetic-secret'); }).add(grant), /OAUTH_VERSION_PRESERVATION_FAILED/);
    assert.equal(writes, 1);
});
test('Secret Manager 설정은 다른 논리 소스·정적 SA 키·user ADC를 fallback으로 사용하지 않는다', async () => { assert.throws(() => new SecretManagerConsoleGrantVersions('projects/demo/secrets/oauth', async () => ({}))); await assert.rejects(SecretManagerConsoleGrantVersions.fromWif(resource, '/does-not-exist', 'unregistered'), /OAUTH_STORE_CONFIGURATION_INVALID/); });
