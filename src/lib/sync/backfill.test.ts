import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reconcileRepositoryWhere } from "@/lib/sync/reconcile-scope";

test("reconcile은 앱 목록이 아니라 active RepositoryRegistration 전체를 정본으로 사용한다", () => {
  assert.deepEqual(reconcileRepositoryWhere, {
    archived: false,
    status: { not: "ARCHIVED" },
  });

  const source = readFileSync(join(process.cwd(), "src/lib/sync/backfill.ts"), "utf8");
  const reconcileSource = source.slice(source.indexOf("export async function reconcileAll"));
  assert.match(reconcileSource, /repositoryRegistration\.findMany/u);
  assert.doesNotMatch(reconcileSource, /prisma\.app\.findMany/u);
});
