import assert from "node:assert/strict";
import test from "node:test";
import { connectAccount } from "./links";
test("만료·이미 사용된 연결 코드와 접근 권한 없는 계정은 연결되지 않는다", async () => {
  for (const state of ["expired", "consumed", "denied", "missing"]) {
    let writes = 0;
    const db = { $transaction: async (fn: (tx: unknown) => Promise<void>) => fn({ discordLinkCode: { findUnique: async () => state === "missing" ? null : { githubId: 1n, consumedAt: state === "consumed" ? new Date() : null, expiresAt: state === "expired" ? new Date(0) : new Date(Date.now() + 60_000) } }, user: { findUnique: async () => ({ allowlisted: state !== "denied" }) }, discordAccountLink: { create: async () => { writes++; } } }) } as unknown as NonNullable<Parameters<typeof connectAccount>[2]>;
    await assert.rejects(connectAccount("a".repeat(24), "discord1", db)); assert.equal(writes, 0);
  }
});
