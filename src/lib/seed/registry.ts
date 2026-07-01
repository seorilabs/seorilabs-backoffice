import { prisma } from "@/lib/prisma";
import { getInstallationOctokit } from "@/lib/github/app";
import { backfillRepo } from "@/lib/sync/backfill";
import { env } from "@/lib/env";
import { computeRepoSeed, type Octo, type RepoLite } from "./compute";

// 레지스트리 부트스트랩. Next 런타임에서 실행(octokit 번들).
// 순수 계산부(octokit read → marketTargets → configHash → 시드 데이터)는 compute.ts 로 분리했고,
// 여기서는 그 결과를 받아 prisma upsert(멱등)만 수행한다.

const IGNORE = new Set([
  "gemini-pr-bot",
  "seori-pr-bot",
  "seorilabs-official",
  "seorilabs-backoffice",
  ".github",
  "archive",
]);

async function seedRepo(
  octokit: Octo,
  org: string,
  repo: RepoLite,
): Promise<"seeded" | "skipped"> {
  const seed = await computeRepoSeed(octokit, org, repo);
  if (!seed) return "skipped"; // RN/Godot 아님(예: Unity)

  // configHash 가 동일하면(= config/워크플로우 존재 신호 모두 불변) 재기록을 생략한다(멱등).
  const existing = await prisma.app.findUnique({
    where: { repoFullName: repo.full_name },
    select: { configHash: true },
  });
  if (existing?.configHash === seed.configHash) return "seeded";

  await prisma.app.upsert({
    where: { repoFullName: repo.full_name },
    create: seed,
    update: {
      // currentStage/status 는 운영 상태이므로 시드가 덮지 않음.
      displayName: seed.displayName,
      repoId: seed.repoId,
      type: seed.type,
      engine: seed.engine,
      isPublicRepo: seed.isPublicRepo,
      firebaseProject: seed.firebaseProject,
      playPackage: seed.playPackage,
      iosBundle: seed.iosBundle,
      appleTeamId: seed.appleTeamId,
      iosSku: seed.iosSku,
      aitAppName: seed.aitAppName,
      marketTargets: seed.marketTargets,
      configHash: seed.configHash,
      configSyncedAt: seed.configSyncedAt,
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
