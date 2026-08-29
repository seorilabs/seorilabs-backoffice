import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const script = join(process.cwd(), "scripts/prune-standalone-prisma-engines.sh");
const targetName = "libquery_engine-linux-arm64-openssl-3.0.x.so.node";

function fixture(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "backoffice-prisma-engines-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

function put(root: string, relativePath: string, contents = relativePath): string {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function prune(root: string) {
  return spawnSync("sh", [script, root], { encoding: "utf8" });
}

test("standalone에서 non-ARM64 Prisma engine만 제거하고 target을 보존한다", (t) => {
  const root = fixture(t);
  const client = "node_modules/.prisma/client";
  const target = put(root, `${client}/${targetName}`, "arm64-engine");
  const linuxX64 = put(
    root,
    `${client}/libquery_engine-debian-openssl-3.0.x.so.node`,
  );
  const darwinArm64 = put(root, `${client}/libquery_engine-darwin-arm64.dylib.node`);
  const wrongOpenSsl = put(
    root,
    `${client}/libquery_engine-linux-arm64-openssl-1.1.x.so.node`,
  );
  const binaryQueryEngine = put(
    root,
    `${client}/query-engine-debian-openssl-3.0.x`,
  );
  const schemaEngine = put(
    root,
    `${client}/schema-engine-debian-openssl-3.0.x`,
  );
  const unrelatedAddon = put(root, "node_modules/native-addon/addon-linux-x64.node");
  const outsidePrismaClient = put(
    root,
    "node_modules/native-addon/libquery_engine-custom.so.node",
  );

  const result = prune(root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(target, "utf8"), "arm64-engine");
  assert.equal(existsSync(linuxX64), false);
  assert.equal(existsSync(darwinArm64), false);
  assert.equal(existsSync(wrongOpenSsl), false);
  assert.equal(existsSync(binaryQueryEngine), false);
  assert.equal(existsSync(schemaEngine), false);
  assert.equal(existsSync(unrelatedAddon), true);
  assert.equal(existsSync(outsidePrismaClient), true);
});

test("target engine이 없으면 다른 engine을 지우기 전에 실패한다", (t) => {
  const root = fixture(t);
  const hostEngine = put(
    root,
    "node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node",
  );

  const result = prune(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /정확히 하나/);
  assert.equal(existsSync(hostEngine), true);
});

test("target engine이 중복이면 다른 engine을 지우기 전에 실패한다", (t) => {
  const root = fixture(t);
  put(root, `first/.prisma/client/${targetName}`);
  put(root, `second/.prisma/client/${targetName}`);
  const hostEngine = put(
    root,
    "third/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node",
  );

  const result = prune(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /count=2/);
  assert.equal(existsSync(hostEngine), true);
});
