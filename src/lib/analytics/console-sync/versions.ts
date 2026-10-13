import { readFile, open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import { ConsoleSyncError, consoleCredentialSchema } from './oauth';
export const storedConsoleGrantSchema = consoleCredentialSchema.extend({ generation: z.number().int().min(1), accessToken: z.string().min(1), expiresAt: z.number().int().positive() });
export type StoredConsoleGrant = z.infer<typeof storedConsoleGrantSchema>;
export interface ConsoleGrantVersions {
    read(version: string): Promise<StoredConsoleGrant>;
    add(grant: StoredConsoleGrant): Promise<string>;
}
export const secretResourceSchema = z.string().regex(/^projects\/[1-9]\d*\/secrets\/[A-Za-z0-9_-]{1,255}$/);
export function assertExactVersion(version: string, resource?: string) {
    if (resource ? !version.startsWith(`${resource}/versions/`) || !/^[1-9]\d*$/.test(version.slice(`${resource}/versions/`.length))
        : !/^local\/versions\/[a-f0-9-]{36}$/.test(version))
        throw new ConsoleSyncError('OAUTH_VERSION_INVALID');
}
export function crc32c(bytes: Uint8Array) { let crc = 0xffffffff; for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
} return (crc ^ 0xffffffff) >>> 0; }
// 파일은 테스트/최초 인가 전용이다. 운영 수집기는 이 어댑터를 선택할 수 없다.
export class LocalConsoleGrantVersions implements ConsoleGrantVersions {
    constructor(private readonly directory: string) { }
    static async initialize(directory: string) {
        const store = new LocalConsoleGrantVersions(directory);
        await store.check();
        const h = await open(join(directory, 'encryption.key'), 'wx', 0o600);
        try {
            await h.writeFile(randomBytes(32));
            await h.sync();
        }
        finally {
            await h.close();
        }
        return store;
    }
    private async key() { const file = join(this.directory, 'encryption.key'); const s = await lstat(file); if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077))
        throw new ConsoleSyncError('OAUTH_FILE_NOT_PRIVATE'); const key = await readFile(file); if (key.length !== 32)
        throw new ConsoleSyncError('OAUTH_STORE_CONFIGURATION_INVALID'); return key; }
    private async check() { const s = await lstat(this.directory); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077))
        throw new ConsoleSyncError('OAUTH_FILE_NOT_PRIVATE'); }
    async read(version: string) { try {
        await this.check();
        assertExactVersion(version);
        const file = join(this.directory, `${version.split('/').at(-1)}.json`);
        const s = await lstat(file);
        if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077))
            throw new ConsoleSyncError('OAUTH_FILE_NOT_PRIVATE');
        const envelope = z.object({ iv: z.string(), tag: z.string(), data: z.string() }).strict().parse(JSON.parse(await readFile(file, 'utf8')));
        const decipher = createDecipheriv('aes-256-gcm', await this.key(), Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from(version));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const bytes = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
        return storedConsoleGrantSchema.parse(JSON.parse(bytes.toString('utf8')));
    }
    catch {
        throw new ConsoleSyncError('OAUTH_VERSION_UNREADABLE');
    } }
    async add(grant: StoredConsoleGrant) { try {
        await this.check();
        const parsed = storedConsoleGrantSchema.parse(grant);
        const id = randomUUID();
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', await this.key(), iv);
        cipher.setAAD(Buffer.from(`local/versions/${id}`));
        const data = Buffer.concat([cipher.update(JSON.stringify(parsed), 'utf8'), cipher.final()]);
        const envelope = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
        const h = await open(join(this.directory, `${id}.json`), 'wx', 0o600);
        try {
            await h.writeFile(JSON.stringify(envelope));
            await h.sync();
        }
        finally {
            await h.close();
        }
        const dir = await open(this.directory, 'r');
        try {
            await dir.sync();
        }
        finally {
            await dir.close();
        }
        return `local/versions/${id}`;
    }
    catch {
        throw new ConsoleSyncError('OAUTH_VERSION_PRESERVATION_FAILED');
    } }
}
type SecretRequest = (url: string, method: 'GET' | 'POST', data?: unknown) => Promise<unknown>;
export class SecretManagerConsoleGrantVersions implements ConsoleGrantVersions {
    private readonly resource: string;
    constructor(resource: string, private readonly request: SecretRequest) { const p = secretResourceSchema.safeParse(resource); if (!p.success)
        throw new ConsoleSyncError('OAUTH_STORE_CONFIGURATION_INVALID'); this.resource = p.data; }
    async read(version: string) { try {
        assertExactVersion(version, this.resource);
        const result = z.object({ name: z.literal(version), payload: z.object({ data: z.string().min(1), dataCrc32c: z.string().regex(/^\d+$/) }) }).parse(await this.request(`https://secretmanager.googleapis.com/v1/${version}:access`, 'GET'));
        const bytes = Buffer.from(result.payload.data, 'base64');
        if (bytes.toString('base64') !== result.payload.data || crc32c(bytes) !== Number(result.payload.dataCrc32c))
            throw new Error('CHECKSUM');
        return storedConsoleGrantSchema.parse(JSON.parse(bytes.toString('utf8')));
    }
    catch {
        throw new ConsoleSyncError('OAUTH_VERSION_UNREADABLE');
    } }
    async add(grant: StoredConsoleGrant) { try {
        const bytes = Buffer.from(JSON.stringify(storedConsoleGrantSchema.parse(grant)));
        const result = z.object({ name: z.string(), state: z.literal('ENABLED'), clientSpecifiedPayloadChecksum: z.literal(true) }).parse(await this.request(`https://secretmanager.googleapis.com/v1/${this.resource}:addVersion`, 'POST', { payload: { data: bytes.toString('base64'), dataCrc32c: String(crc32c(bytes)) } }));
        assertExactVersion(result.name, this.resource);
        return result.name;
    }
    catch {
        throw new ConsoleSyncError('OAUTH_VERSION_PRESERVATION_FAILED');
    } }
    static async fromWif(resource: string, file: string, audience: string) {
        try {
            const config = JSON.parse(await readFile(file, 'utf8'));
            // 정적 키/사용자 ADC fallback은 허용하지 않는다. 승인된 projected JWT만 읽는다.
            const parsed = z.object({ type: z.literal('external_account'), audience: z.literal(audience), subject_token_type: z.literal('urn:ietf:params:oauth:token-type:jwt'), token_url: z.literal('https://sts.googleapis.com/v1/token'), credential_source: z.object({ file: z.literal('/run/secrets/ait-console-wif/token') }).strict(), service_account_impersonation_url: z.string().regex(/^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/[a-zA-Z0-9@._-]+:generateAccessToken$/).optional() }).strict().parse(config);
            if (!/^\/\/iam.googleapis.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(audience))
                throw new Error('AUDIENCE');
            const auth = new GoogleAuth({ credentials: parsed, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
            const client = await auth.getClient();
            return new SecretManagerConsoleGrantVersions(resource, async (url, method, data) => { const response = await client.request({ url, method, data, retry: false, timeout: 30000 }); return response.data; });
        }
        catch {
            throw new ConsoleSyncError('OAUTH_STORE_CONFIGURATION_INVALID');
        }
    }
}
