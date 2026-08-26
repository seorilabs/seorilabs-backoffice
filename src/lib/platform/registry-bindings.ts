import { prisma } from "@/lib/prisma";
import type { Octo } from "@/lib/seed/compute";

export const PLATFORM_REGISTRY_REPO = "platform";
export const PLATFORM_REGISTRY_REF = "main";
export const PLATFORM_REGISTRY_PATH = "registry/apps";

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PlatformRegistryIdentity {
  appId: string;
  firebaseProjectId: string | null;
}

export interface BackofficeAppIdentity {
  id: string;
  slug: string;
  firebaseProject: string | null;
  platformAppId: string | null;
}

export interface PlatformRegistryBinding {
  appRecordId: string;
  platformAppId: string | null;
}

export function isPlatformRegistryPush(
  repoFullName: string,
  ref: string,
  org: string,
): boolean {
  return (
    repoFullName === `${org}/${PLATFORM_REGISTRY_REPO}` &&
    ref === `refs/heads/${PLATFORM_REGISTRY_REF}`
  );
}

interface PlatformRegistryFile {
  app_id?: unknown;
  firebase_project_id?: unknown;
}

/**
 * repo slug가 같으면 그대로 결합하고, 이름이 다른 제품만 유일한 Firebase project로
 * 결합한다. 둘 이상의 앱이나 registry 항목이 같은 identity를 주장하면 추측하지 않고
 * 동기화 전체를 실패시킨다.
 */
export function resolvePlatformRegistryBindings(
  apps: readonly BackofficeAppIdentity[],
  registry: readonly PlatformRegistryIdentity[],
): PlatformRegistryBinding[] {
  const registryByAppId = new Map<string, PlatformRegistryIdentity>();
  const registryByFirebase = new Map<string, PlatformRegistryIdentity[]>();

  for (const entry of registry) {
    if (!APP_ID_PATTERN.test(entry.appId)) {
      throw new Error(`Platform registry app_id가 올바르지 않습니다: ${entry.appId}`);
    }
    if (registryByAppId.has(entry.appId)) {
      throw new Error(`Platform registry app_id가 중복됐습니다: ${entry.appId}`);
    }
    registryByAppId.set(entry.appId, entry);

    if (entry.firebaseProjectId) {
      const matches = registryByFirebase.get(entry.firebaseProjectId) ?? [];
      matches.push(entry);
      registryByFirebase.set(entry.firebaseProjectId, matches);
    }
  }

  const claimed = new Map<string, string>();
  return apps.map((app) => {
    let match = registryByAppId.get(app.slug) ?? null;
    if (!match && app.firebaseProject) {
      const candidates = registryByFirebase.get(app.firebaseProject) ?? [];
      if (candidates.length > 1) {
        throw new Error(
          `Platform registry Firebase project가 중복됐습니다: ${app.firebaseProject}`,
        );
      }
      match = candidates[0] ?? null;
    }

    if (match) {
      const previousApp = claimed.get(match.appId);
      if (previousApp && previousApp !== app.id) {
        throw new Error(
          `Platform app_id ${match.appId}가 여러 Backoffice 앱에 매핑됩니다: ${previousApp}, ${app.id}`,
        );
      }
      claimed.set(match.appId, app.id);
    }

    return {
      appRecordId: app.id,
      platformAppId: match?.appId ?? null,
    };
  });
}

export async function loadPlatformRegistryIdentities(
  octokit: Octo,
  org: string,
): Promise<PlatformRegistryIdentity[]> {
  const directory = await octokit.rest.repos.getContent({
    owner: org,
    repo: PLATFORM_REGISTRY_REPO,
    path: PLATFORM_REGISTRY_PATH,
    ref: PLATFORM_REGISTRY_REF,
  });
  if (!Array.isArray(directory.data)) {
    throw new Error(`${PLATFORM_REGISTRY_PATH}가 디렉터리가 아닙니다.`);
  }

  const files = directory.data
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (files.length === 0) {
    throw new Error("Platform registry JSON을 찾지 못했습니다.");
  }

  return Promise.all(
    files.map(async (entry) => {
      const response = await octokit.rest.repos.getContent({
        owner: org,
        repo: PLATFORM_REGISTRY_REPO,
        path: entry.path,
        ref: PLATFORM_REGISTRY_REF,
      });
      if (
        Array.isArray(response.data) ||
        response.data.type !== "file" ||
        !("content" in response.data) ||
        !response.data.content
      ) {
        throw new Error(`Platform registry 파일을 읽지 못했습니다: ${entry.path}`);
      }

      let parsed: PlatformRegistryFile;
      try {
        parsed = JSON.parse(
          Buffer.from(response.data.content, "base64").toString("utf8"),
        ) as PlatformRegistryFile;
      } catch {
        throw new Error(`Platform registry JSON이 올바르지 않습니다: ${entry.path}`);
      }

      if (typeof parsed.app_id !== "string") {
        throw new Error(`Platform registry app_id가 없습니다: ${entry.path}`);
      }
      if (
        parsed.firebase_project_id !== undefined &&
        typeof parsed.firebase_project_id !== "string"
      ) {
        throw new Error(
          `Platform registry firebase_project_id가 올바르지 않습니다: ${entry.path}`,
        );
      }

      return {
        appId: parsed.app_id,
        firebaseProjectId: parsed.firebase_project_id ?? null,
      };
    }),
  );
}

export async function syncPlatformRegistryBindings(
  octokit: Octo,
  org: string,
): Promise<{ apps: number; registryEntries: number; bound: number; updated: number }> {
  const registry = await loadPlatformRegistryIdentities(octokit, org);
  const apps = await prisma.app.findMany({
    select: {
      id: true,
      slug: true,
      firebaseProject: true,
      platformAppId: true,
    },
  });
  const bindings = resolvePlatformRegistryBindings(apps, registry);
  const currentById = new Map(apps.map((app) => [app.id, app.platformAppId]));
  const changed = bindings.filter(
    (binding) => currentById.get(binding.appRecordId) !== binding.platformAppId,
  );

  if (changed.length > 0) {
    await prisma.$transaction(
      changed.map((binding) =>
        prisma.app.update({
          where: { id: binding.appRecordId },
          data: { platformAppId: binding.platformAppId },
        }),
      ),
    );
  }

  return {
    apps: apps.length,
    registryEntries: registry.length,
    bound: bindings.filter((binding) => binding.platformAppId !== null).length,
    updated: changed.length,
  };
}
