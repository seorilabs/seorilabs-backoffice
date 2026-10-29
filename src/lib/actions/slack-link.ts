"use server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { issueLinkCode, disconnectAccount } from "@/lib/deployment-approvals/links";
async function currentUser() {
  const session = await requireSession();
  const login = session.user?.login;
  if (!login) throw new Error("로그인 필요");
  const user = await prisma.user.findUnique({ where: { login } });
  if (!user?.allowlisted) throw new Error("Backoffice 접근 권한 없음");
  return user;
}
export async function createSlackLinkCode() {
  const user = await currentUser();
  return issueLinkCode(user.githubId);
}
export async function removeSlackLink() {
  const user = await currentUser();
  await disconnectAccount(user.githubId, user.login);
}
