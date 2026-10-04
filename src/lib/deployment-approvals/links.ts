import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
const hash = (code: string) => createHash("sha256").update(code).digest("hex");
export async function issueLinkCode(githubId: bigint) {
  const code = randomBytes(18).toString("base64url");
  await prisma.$transaction(async tx => {
    await tx.discordLinkCode.updateMany({ where: { githubId, consumedAt: null }, data: { consumedAt: new Date() } });
    await tx.discordLinkCode.create({ data: { githubId, codeHash: hash(code), expiresAt: new Date(Date.now() + 600_000) } });
  });
  return code;
}
export async function connectAccount(code: string, discordUserId: string, db = prisma) {
  if (!/^[\w-]{24}$/.test(code)) throw new Error("연결 코드가 올바르지 않습니다.");
  await db.$transaction(async tx => {
    const row = await tx.discordLinkCode.findUnique({ where: { codeHash: hash(code) } });
    if (!row || row.consumedAt || row.expiresAt <= new Date()) throw new Error("연결 코드가 만료됐거나 이미 사용됐습니다.");
    const user = await tx.user.findUnique({ where: { githubId: row.githubId } });
    if (!user?.allowlisted) throw new Error("Backoffice 접근 권한 없음");
    const claimed = await tx.discordLinkCode.updateMany({ where: { codeHash: row.codeHash, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    if (claimed.count !== 1) throw new Error("이미 사용된 연결 코드");
    await tx.discordAccountLink.create({ data: { githubId: row.githubId, discordUserId } });
    await tx.auditLog.create({ data: { actorLogin: user.login, action: "discord.account.connected", entityType: "discord_account_link", entityId: String(row.githubId), payload: { discordUserId } } });
  });
}
export async function disconnectAccount(githubId: bigint, login: string) {
  await prisma.$transaction(async tx => {
    await tx.discordAccountLink.deleteMany({ where: { githubId } });
    await tx.discordLinkCode.updateMany({ where: { githubId, consumedAt: null }, data: { consumedAt: new Date() } });
    await tx.auditLog.create({ data: { actorLogin: login, action: "discord.account.disconnected", entityType: "discord_account_link", entityId: String(githubId) } });
  });
}
