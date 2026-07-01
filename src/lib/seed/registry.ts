import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getInstallationOctokit } from "@/lib/github/app";
import { backfillRepo } from "@/lib/sync/backfill";
import { env } from "@/lib/env";
import { deriveMarketTargets } from "./market-targets";
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

// 모든 read 는 레포의 실제 기본 브랜치(ref)를 명시적으로 대상으로 한다.
// getContent 는 ref 미지정 시 기본 브랜치로 resolve 되지만, 기본 브랜치가 main 이 아닌 레포도 있으므로
// 호출측이 resolve 한 기본 브랜치를 일관되게 넘겨 config/워크플로우 존재가 동일 ref 에서 판정되도록 한다.
// (workflow_dispatch 는 기본 브랜치에 워크플로우 파일이 있어야 dispatch 가능하므로 이 ref 판정이 계약과 일치.)
async function getText(
  octokit: Octo,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path, ref });
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
  ref: string,
): Promise<T | null> {
  const text = await getText(octokit, owner, repo, path, ref);
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
  ref: string,
): Promise<boolean> {
  try {
    await octokit.rest.repos.getContent({ owner, repo, path, ref });
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
  defaultBranch: string;
}

async function seedRepo(
  octokit: Octo,
  org: string,
  repo: RepoLite,
): Promise<"seeded" | "skipped"> {
  const name = repo.name;
  // 모든 config/워크플로우 존재 판정을 레포의 실제 기본 브랜치에서 일관되게 수행한다.
  const ref = repo.defaultBranch;

  const isGodot = await pathExists(octokit, org, name, "project.godot", ref);
  const hasPackageJson = await pathExists(octokit, org, name, "package.json", ref);
  if (!isGodot && !hasPackageJson) return "skipped"; // RN/Godot 아님(예: Unity)

  const engine: AppEngine = isGodot ? "GODOT" : "RN";

  const play = await getJson<PlayConfig>(
    octokit,
    org,
    name,
    "play-store/google-play.config.json",
    ref,
  );

  const appStore = await getJson<AppStoreConfig>(
    octokit,
    org,
    name,
    "app-store/app-store.config.json",
    ref,
  );

  const firebaserc = await getJson<FirebaseRc>(octokit, org, name, ".firebaserc", ref);

  // AIT(Granite/Bedrock) 앱의 aitAppName 메타데이터 추출. engine과 무관하게 두 config 위치를 확인한다.
  // Granite 앱은 RN(apps/ait/granite.config.ts) 또는 web/Vite(레포 루트 granite.config.ts) 레이아웃일 수 있고,
  // 별도로 apps-in-toss/apps-in-toss.config.json 을 둘 수도 있다(예: Godot).
  // (marketTargets 의 ait 포함 여부는 config 가 아니라 아래 표준 배포 워크플로우 존재로 판정한다.)
  const rootGranite = await getText(octokit, org, name, "granite.config.ts", ref);
  const rnGranite = await getText(octokit, org, name, "apps/ait/granite.config.ts", ref);
  const aitReal = await getJson<{ appName?: unknown }>(
    octokit,
    org,
    name,
    "apps-in-toss/apps-in-toss.config.json",
    ref,
  );

  const graniteText = rootGranite ?? rnGranite;

  // aitAppName 은 실제 config 우선. granite.config.ts 는 appName: 정규식으로, apps-in-toss.config.json 은 pickAppName 으로 추출.
  const graniteAppName = graniteText?.match(/appName\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? null;
  const aitAppName = aitReal ? pickAppName(aitReal.appName) : graniteAppName;

  const hasWeb = await pathExists(octokit, org, name, "web", ref);

  // marketTargets = 실제로 dispatch 가능한 마켓만 포함한다(= Backoffice/Telegram /deploy 버튼이 진실이 되도록).
  // deployTargetsFor 가 marketTargets → 표준 배포 caller 워크플로우로 매핑하므로(ait→deploy-apps-in-toss.yml,
  // play→deploy-google-play.yml, appstore→deploy-app-store.yml), config 만 있고 해당 워크플로우가 없으면
  // (예: deploy-godot-pages.yml 만 둔 Godot 게임) dispatch 가 404 였다.
  // 따라서 config 존재가 아니라 기본 브랜치의 표준 배포 워크플로우 파일 존재를 근거로 삼는다.
  const hasPlayWorkflow = await pathExists(
    octokit,
    org,
    name,
    ".github/workflows/deploy-google-play.yml",
    ref,
  );
  const hasAppStoreWorkflow = await pathExists(
    octokit,
    org,
    name,
    ".github/workflows/deploy-app-store.yml",
    ref,
  );
  const hasAitWorkflow = await pathExists(
    octokit,
    org,
    name,
    ".github/workflows/deploy-apps-in-toss.yml",
    ref,
  );

  // 파생은 순수 함수(deriveMarketTargets)로 위임 → 단위 테스트 가능.
  const marketTargets = deriveMarketTargets({
    hasPlayWorkflow,
    hasAppStoreWorkflow,
    hasAitWorkflow,
    hasWeb,
  });

  const appType = play?.appType ?? appStore?.appType;
  const type: AppType =
    engine === "GODOT" || appType?.toLowerCase() === "game" ? "GAME" : "APP";

  const displayName =
    pickAppName(play?.storeListing?.appName) ??
    name
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");

  // configHash 는 marketTargets 를 결정하는 워크플로우 존재 신호를 반드시 포함한다.
  // 그래야 config 는 그대로여도 배포 워크플로우가 추가/삭제되면 hash 가 바뀌어 재시드가 강제되고,
  // 동일 hash 로 인한 stale skip(= marketTargets 미갱신)이 발생하지 않는다.
  const configHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        play,
        appStore,
        firebaserc,
        aitAppName,
        marketTargets,
        hasPlayWorkflow,
        hasAppStoreWorkflow,
        hasAitWorkflow,
        hasWeb,
        type,
        engine,
      }),
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
        defaultBranch: r.default_branch ?? "main",
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
