import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getInstallationOctokit } from "@/lib/github/app";
import { backfillRepo } from "@/lib/sync/backfill";
import { env } from "@/lib/env";
import type { AppType, AppEngine } from "@prisma/client";

// 레지스트리 부트스트랩. Next 런타임에서 실행(octokit 번들).
// R4: Godot 레포는 config 경로가 다르고 .example.json 만 있을 수 있음 → 미설정(null + UI "확정 필요").

const IGNORE = new Set([
  "gemini-pr-bot",
  "seori-pr-bot",
  "seorilabs-official",
  "seorilabs-backoffice",
  ".github",
  "archive",
]);

type Octo = Awaited<ReturnType<typeof getInstallationOctokit>>;

async function getText(
  octokit: Octo,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path });
    const data = res.data;
    if (Array.isArray(data)) return null;
    if (data.type === "file" && "content" in data && data.content) {
      return Buffer.from(data.content, "base64").toString("utf8");
    }
    return null;
  } catch {
    return null;
  }
}

async function getJson<T = Record<string, unknown>>(
  octokit: Octo,
  owner: string,
  repo: string,
  path: string,
): Promise<T | null> {
  const text = await getText(octokit, owner, repo, path);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function pathExists(
  octokit: Octo,
  owner: string,
  repo: string,
  path: string,
): Promise<boolean> {
  try {
    await octokit.rest.repos.getContent({ owner, repo, path });
    return true;
  } catch {
    return false;
  }
}

function pickAppName(appName: unknown): string | null {
  if (typeof appName === "string") return appName;
  if (appName && typeof appName === "object") {
    const o = appName as Record<string, string>;
    return o["ko-KR"] ?? o["en-US"] ?? Object.values(o)[0] ?? null;
  }
  return null;
}

interface PlayConfig {
  packageName?: string;
  appType?: string;
  storeListing?: { appName?: unknown };
}
interface AppStoreConfig {
  bundleId?: string;
  appleTeamId?: string;
  sku?: string;
  appType?: string;
}
interface FirebaseRc {
  projects?: { default?: string };
}

interface RepoLite {
  name: string;
  full_name: string;
  id: number;
  private: boolean;
}

async function seedRepo(
  octokit: Octo,
  org: string,
  repo: RepoLite,
): Promise<"seeded" | "skipped"> {
  const name = repo.name;

  const isGodot = await pathExists(octokit, org, name, "project.godot");
  const hasPackageJson = await pathExists(octokit, org, name, "package.json");
  if (!isGodot && !hasPackageJson) return "skipped"; // RN/Godot 아님(예: Unity)

  const engine: AppEngine = isGodot ? "GODOT" : "RN";

  const play = await getJson<PlayConfig>(
    octokit,
    org,
    name,
    "play-store/google-play.config.json",
  );
  const playExample = play
    ? false
    : await pathExists(octokit, org, name, "play-store/google-play.config.example.json");

  const appStore = await getJson<AppStoreConfig>(
    octokit,
    org,
    name,
    "app-store/app-store.config.json",
  );
  const appStoreExample = appStore
    ? false
    : await pathExists(octokit, org, name, "app-store/app-store.config.example.json");

  const firebaserc = await getJson<FirebaseRc>(octokit, org, name, ".firebaserc");

  let hasAit = false;
  let aitAppName: string | null = null;
  if (engine === "RN") {
    hasAit = await pathExists(octokit, org, name, "apps/ait/granite.config.ts");
    const granite = await getText(octokit, org, name, "apps/ait/granite.config.ts");
    const m = granite?.match(/appName\s*:\s*["'`]([^"'`]+)["'`]/);
    aitAppName = m ? m[1] : null;
  } else {
    const aitReal = await getJson<{ appName?: unknown }>(
      octokit,
      org,
      name,
      "apps-in-toss/apps-in-toss.config.json",
    );
    const aitExample = aitReal
      ? false
      : await pathExists(octokit, org, name, "apps-in-toss/apps-in-toss.config.example.json");
    hasAit = !!aitReal || aitExample;
    aitAppName = aitReal ? pickAppName(aitReal.appName) : null;
  }

  const hasWeb = await pathExists(octokit, org, name, "web");

  const marketTargets: string[] = [];
  if (play || playExample) marketTargets.push("play");
  if (appStore || appStoreExample) marketTargets.push("appstore");
  if (hasAit) marketTargets.push("ait");
  if (hasWeb) marketTargets.push("web");

  const appType = play?.appType ?? appStore?.appType;
  const type: AppType =
    engine === "GODOT" || appType?.toLowerCase() === "game" ? "GAME" : "APP";

  const displayName =
    pickAppName(play?.storeListing?.appName) ??
    name
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");

  const configHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({ play, appStore, firebaserc, aitAppName, marketTargets, type, engine }),
    )
    .digest("hex");

  const existing = await prisma.app.findUnique({
    where: { repoFullName: repo.full_name },
    select: { configHash: true },
  });
  if (existing?.configHash === configHash) return "seeded";

  const data = {
    slug: name,
    displayName,
    repoFullName: repo.full_name,
    repoId: BigInt(repo.id),
    type,
    engine,
    isPublicRepo: !repo.private,
    firebaseProject: firebaserc?.projects?.default ?? null,
    playPackage: play?.packageName ?? null,
    iosBundle: appStore?.bundleId ?? null,
    appleTeamId: appStore?.appleTeamId ?? null,
    iosSku: appStore?.sku ?? null,
    aitAppName,
    marketTargets,
    configHash,
    configSyncedAt: new Date(),
  };

  await prisma.app.upsert({
    where: { repoFullName: repo.full_name },
    create: data,
    update: {
      // currentStage/status 는 운영 상태이므로 시드가 덮지 않음.
      displayName: data.displayName,
      repoId: data.repoId,
      type: data.type,
      engine: data.engine,
      isPublicRepo: data.isPublicRepo,
      firebaseProject: data.firebaseProject,
      playPackage: data.playPackage,
      iosBundle: data.iosBundle,
      appleTeamId: data.appleTeamId,
      iosSku: data.iosSku,
      aitAppName: data.aitAppName,
      marketTargets: data.marketTargets,
      configHash: data.configHash,
      configSyncedAt: data.configSyncedAt,
    },
  });
  return "seeded";
}

export async function seedRegistry(opts: { backfill?: boolean } = {}): Promise<{
  seeded: number;
  skipped: number;
  backfilled: number;
}> {
  const org = env.githubOrg();
  const octokit = await getInstallationOctokit();
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    per_page: 100,
    type: "all",
  });

  const targets = repos.filter(
    (r) =>
      !r.archived &&
      !r.fork &&
      !IGNORE.has(r.name) &&
      !r.name.startsWith("starter-template"),
  );

  let seeded = 0;
  let skipped = 0;
  for (const r of targets) {
    try {
      const result = await seedRepo(octokit, org, {
        name: r.name,
        full_name: r.full_name,
        id: r.id,
        private: r.private,
      });
      if (result === "seeded") seeded++;
      else skipped++;
    } catch (e) {
      console.error(`[seed] ${r.full_name} 실패:`, e);
    }
  }

  let backfilled = 0;
  if (opts.backfill !== false) {
    const apps = await prisma.app.findMany({ select: { repoFullName: true } });
    for (const a of apps) {
      try {
        await backfillRepo(a.repoFullName);
        backfilled++;
      } catch (e) {
        console.error(`[seed] backfill ${a.repoFullName} 실패:`, e);
      }
    }
  }

  return { seeded, skipped, backfilled };
}
