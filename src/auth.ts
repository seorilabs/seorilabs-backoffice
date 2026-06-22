import NextAuth from "next-auth";
import authConfig from "@/auth.config";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { getInstallationOctokit } from "@/lib/github/app";

interface GithubProfile {
  login: string;
  id: number;
  name?: string | null;
  avatar_url?: string | null;
}

async function checkOrgMembership(login: string): Promise<boolean> {
  try {
    const octokit = await getInstallationOctokit();
    const res = await octokit.rest.orgs.getMembershipForUser({
      org: env.githubOrg(),
      username: login,
    });
    return res.data.state === "active";
  } catch {
    return false;
  }
}

// 로그인 시 User upsert + allowlist 판정.
// 우선순위: env ALLOWLIST_LOGINS → User.allowlisted → org 멤버십(보조).
async function ensureUserAndAllow(profile: GithubProfile): Promise<boolean> {
  const login = profile.login;
  const githubId = BigInt(profile.id);
  const existing = await prisma.user.findUnique({ where: { githubId } });

  const envAllow = env.allowlistLogins().includes(login.toLowerCase());
  let allowlisted = existing?.allowlisted ?? false;
  if (envAllow) allowlisted = true;
  if (!allowlisted) allowlisted = await checkOrgMembership(login);

  await prisma.user.upsert({
    where: { githubId },
    create: {
      githubId,
      login,
      name: profile.name ?? null,
      avatarUrl: profile.avatar_url ?? null,
      allowlisted,
      lastLoginAt: new Date(),
      role: envAllow ? "ADMIN" : "VIEWER",
    },
    update: {
      login,
      name: profile.name ?? null,
      avatarUrl: profile.avatar_url ?? null,
      allowlisted,
      lastLoginAt: new Date(),
    },
  });
  return allowlisted;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ profile }) {
      if (!profile) return false;
      const p = profile as unknown as GithubProfile;
      if (!p.login || !p.id) return false;
      return ensureUserAndAllow(p);
    },
    async jwt({ token, profile }) {
      if (profile) {
        const p = profile as unknown as GithubProfile;
        token.login = p.login;
      }
      return token;
    },
    async session({ session, token }) {
      const login = token.login as string | undefined;
      if (login && session.user) {
        session.user.login = login;
      }
      return session;
    },
  },
});
