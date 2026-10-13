// 격리 파드 실측 전용. 운영 Secret Manager/IAM을 대신한 검증으로 표시하지 않는다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { LocalConsoleGrantVersions, storedConsoleGrantSchema } from '../../src/lib/analytics/console-sync/versions';
import { consoleErrorCode } from '../../src/lib/analytics/console-sync/oauth';
async function main() {
    if (process.env.NODE_ENV === 'production' || process.env.QA_CONSOLE_STORE_DIRECTORY !== '/qa-store' || process.env.QA_CONSOLE_AUTH_FILE !== '/qa-auth/gateway.key')
        throw Error('ISOLATED_GATEWAY_REQUIRED');
    const key = await readFile('/qa-auth/gateway.key', 'utf8');
    const store = new LocalConsoleGrantVersions('/qa-store');
    const server = createServer(async (req, res) => {
        try {
            const got = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${key}`);
            if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
                res.writeHead(403).end();
                return;
            }
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type', 'application/json');
            const match = /^\/versions\/([a-f0-9-]{36})$/.exec(req.url ?? '');
            if (req.method === 'GET' && match) {
                res.end(JSON.stringify(await store.read(`local/versions/${match[1]}`)));
                return;
            }
            if (req.method === 'POST' && req.url === '/versions') {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 16384)
                        throw Error('BODY_LIMIT');
                    chunks.push(chunk);
                }
                const parsed = storedConsoleGrantSchema.strict().parse(JSON.parse(Buffer.concat(chunks).toString()));
                const version = await store.add(parsed);
                await store.read(version);
                res.end(JSON.stringify({ version }));
                return;
            }
            res.writeHead(404).end();
        }
        catch (e) {
            if (!res.headersSent)
                res.writeHead(500);
            res.end(JSON.stringify({ code: consoleErrorCode(e) }));
        }
    });
    server.listen(8090, '0.0.0.0', () => console.log(JSON.stringify({ state: 'ready', adapter: 'isolated-encrypted-local-store' })));
    for (const sig of ['SIGTERM', 'SIGINT'])
        process.on(sig, () => server.close(() => process.exit(0)));
}
main().catch(() => { console.error(JSON.stringify({ code: 'ISOLATED_GATEWAY_FAILED' })); process.exitCode = 1; });
