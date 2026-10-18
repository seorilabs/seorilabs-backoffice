import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// DB와 외부 계정 없이 실제 Next App Router 렌더러의 재실행을 검증한다.
// 브라우저에서 window.replayResult.assertionPassed와 원래 DOM 보존을 확인한다.
const port = Number(process.argv[2] ?? "3393");
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("INVALID_LOCAL_FIXTURE_PORT");
}
const require = createRequire(import.meta.url);
const nextRoot = dirname(require.resolve("next/package.json"));
const output = await mkdtemp(join(tmpdir(), "backoffice-hydration-replay-"));
await build({
  entryPoints: [fileURLToPath(new URL("./fixtures/hydration-replay-client.tsx", import.meta.url))],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: join(output, "client.js"),
  alias: {
    react: join(nextRoot, "dist/compiled/react"),
    "react-dom": join(nextRoot, "dist/compiled/react-dom"),
  },
  define: { "process.env.NODE_ENV": '"production"' },
});
const client = await readFile(join(output, "client.js"));
const html = '<!doctype html><html><head><meta charset="utf-8"><script defer src="/client.js"></script></head><body><div id="root"><div id="outer"><p id="before">before</p><div id="target"><section id="child">lazy child</section></div><p id="after">after</p></div></div></body></html>';
const server = createServer((request, response) => {
  if (request.url === "/client.js") {
    response.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
    response.end(client);
  } else if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(html);
  } else {
    response.writeHead(404);
    response.end();
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, next: require("next/package.json").version }));
});
const stop = () => server.close(async () => {
  await rm(output, { recursive: true });
  process.exit(0);
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
