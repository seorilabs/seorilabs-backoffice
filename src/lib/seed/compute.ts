import crypto from "node:crypto";
import { deriveMarketTargets } from "./market-targets";
import type { AppType, AppEngine } from "@prisma/client";
import type { Octokit } from "octokit";
import {
  APP_OPS_MANIFEST_PATH,
  parseAppOpsManifestText,
  type AppOpsManifest,
} from "@/lib/app-ops/manifest";

// seedRepo 의 순수 계산부: octokit read → deriveMarketTargets → configHash → 시드 데이터.
// prisma/env 등 부작용 의존을 두지 않고 octokit 만 주입받으므로,
// 가짜 octokit 으로 "워크플로우 존재 판정 → marketTargets → configHash" 통합 경로를 회귀 테스트할 수 있다.
// (DB upsert 는 registry.ts 의 seedRepo 가 이 결과를 받아서 수행한다.)

export type Octo = Octokit;

// 파서가 같은 원본 config에서 다른 시드 값을 산출하게 되면 반드시 올린다.
// configHash가 바뀌어 운영 레지스트리의 기존 레코드도 재시드된다.
const SEED_VERSION = 5;

interface PlayConfig {
  packageName?: string;
  appType?: string;
  storeListing?: { appName?: unknown };
}
interface AppStoreIdentity {
  bundleId?: string;
  appleTeamId?: string;
  sku?: string;
  appType?: string;
}
interface AppStoreConfig extends AppStoreIdentity {
  app?: AppStoreIdentity;
  name?: unknown;
  storeListing?: { appName?: unknown; name?: unknown };
}
interface FirebaseRc {
  projects?: { default?: string };
}

export interface RepoLite {
  name: string;
  full_name: string;
  id: number;
  private: boolean;
  defaultBranch: string;
  description?: string | null;
}

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

function containsHangul(value: string | null): value is string {
  return Boolean(value && /[가-힣]/.test(value));
}

function projectName(project: string | null): string | null {
  return project?.match(/^\s*config\/name\s*=\s*"([^"]+)"/m)?.[1]?.trim() ?? null;
}

function descriptionDisplayName(description: string | null | undefined): string | null {
  const text = description?.trim();
  if (!text) return null;
  const parenthesized = text.match(/^[A-Za-z0-9 ]+\(([가-힣][^)]+)\)/)?.[1];
  if (parenthesized) return parenthesized.trim();
  const prefix = text.split(/\s+(?:—|–|-)\s+/)[0]?.trim();
  if (containsHangul(prefix) && prefix.length <= 30) return prefix;
  if (containsHangul(text) && text.length <= 24) return text;
  return null;
}

// 스토어 상품명과 분리된 Backoffice 운영 표시명. slug/repo identity는 바꾸지 않는다.
const BACKOFFICE_DISPLAY_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  "slotmachine-game": "루시드 슬롯머신",
  "trait-test-hub": "성향 테스트",
};

// 시드가 prisma 에 upsert 하는 앱 레코드(create 페이로드). configHash/marketTargets 포함.
export interface AppSeedData {
  slug: string;
  displayName: string;
  repoFullName: string;
  repoId: bigint;
  type: AppType;
  engine: AppEngine;
  isPublicRepo: boolean;
  firebaseProject: string | null;
  playPackage: string | null;
  iosBundle: string | null;
  appleTeamId: string | null;
  iosSku: string | null;
  aitAppName: string | null;
  marketTargets: string[];
  opsManifest: AppOpsManifest | null;
  opsManifestError: string | null;
  configHash: string;
  configSyncedAt: Date;
}

// octokit read 결과로부터 시드 데이터를 계산한다. null = 시드 대상 아님(skip).
// R4: Godot 레포는 config 경로가 다르고 .example.json 만 있을 수 있음 → 미설정(null + UI "확정 필요").
export async function computeRepoSeed(
  octokit: Octo,
  org: string,
  repo: RepoLite,
): Promise<AppSeedData | null> {
  const name = repo.name;
  // 모든 config/워크플로우 존재 판정을 레포의 실제 기본 브랜치에서 일관되게 수행한다.
  const ref = repo.defaultBranch;

  const godotProject =
    (await getText(octokit, org, name, "project.godot", ref)) ??
    (await getText(octokit, org, name, "godot/project.godot", ref)) ??
    (await getText(octokit, org, name, "game/project.godot", ref));
  const isGodot = godotProject != null;
  const hasPackageJson =
    (await pathExists(octokit, org, name, "package.json", ref)) ||
    (await pathExists(octokit, org, name, "app/package.json", ref));
  if (!isGodot && !hasPackageJson) return null; // RN/Godot 아님(예: Unity)

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
  // 초기 레포의 최상위 형식과 최신 Godot 레포의 app.* 형식을 모두 지원한다.
  // 필드별로 최상위 값을 우선해 기존 설정의 의미를 바꾸지 않는다.
  const appStoreBundleId = appStore?.bundleId ?? appStore?.app?.bundleId;
  const appStoreAppleTeamId = appStore?.appleTeamId ?? appStore?.app?.appleTeamId;
  const appStoreSku = appStore?.sku ?? appStore?.app?.sku;
  const appStoreType = appStore?.appType ?? appStore?.app?.appType;

  const firebaserc = await getJson<FirebaseRc>(octokit, org, name, ".firebaserc", ref);

  // AIT(Granite/Bedrock) 앱의 aitAppName 메타데이터 추출. engine과 무관하게 두 config 위치를 확인한다.
  // Granite 앱은 RN(apps/ait/granite.config.ts) 또는 web/Vite(레포 루트 granite.config.ts) 레이아웃일 수 있고,
  // 별도로 apps-in-toss/apps-in-toss.config.json 을 둘 수도 있다(예: Godot).
  // (marketTargets 의 ait 포함 여부는 config 가 아니라 아래 표준 배포 워크플로우 존재로 판정한다.)
  const rootGranite = await getText(octokit, org, name, "granite.config.ts", ref);
  const rnGranite = await getText(octokit, org, name, "apps/ait/granite.config.ts", ref);
  const aitReal = await getJson<{ appName?: unknown; title?: unknown }>(
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
  const aitTitle = aitReal ? pickAppName(aitReal.title) : null;

  const hasWeb = await pathExists(octokit, org, name, "web", ref);
  const opsManifestText = await getText(
    octokit,
    org,
    name,
    APP_OPS_MANIFEST_PATH,
    ref,
  );
  const { manifest: opsManifest, error: opsManifestError } =
    parseAppOpsManifestText(opsManifestText);

  // marketTargets = 실제로 dispatch 가능한 마켓만 포함한다(= Backoffice/Discord /deploy가 진실이 되도록).
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
  // marketTargets 는 아래 워크플로우 존재 신호(+hasWeb)의 결정적 파생이다.
  const marketTargets = deriveMarketTargets({
    hasPlayWorkflow,
    hasAppStoreWorkflow,
    hasAitWorkflow,
    hasWeb,
  });

  const appType = play?.appType ?? appStoreType;
  const type: AppType =
    engine === "GODOT" || appType?.toLowerCase() === "game" ? "GAME" : "APP";

  const playName = pickAppName(play?.storeListing?.appName);
  const appStoreName = pickAppName(
    appStore?.storeListing?.appName ?? appStore?.storeListing?.name ?? appStore?.name,
  );
  const godotName = projectName(godotProject);
  const descriptionName = descriptionDisplayName(repo.description);
  const koreanName = [
    playName,
    appStoreName,
    godotName,
    descriptionName,
    aitTitle,
    aitAppName,
  ].find(containsHangul);
  const displayName =
    BACKOFFICE_DISPLAY_NAME_OVERRIDES[name] ??
    koreanName ??
    playName ??
    appStoreName ??
    godotName ??
    aitTitle ??
    aitAppName ??
    name
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");

  // configHash 는 marketTargets 를 결정하는 워크플로우 존재 신호(hasPlay/AppStore/AitWorkflow + hasWeb)를
  // 단일 소스로 포함한다. marketTargets 는 이 신호들의 결정적 파생(deriveMarketTargets)이므로 해시 입력에
  // 중복으로 넣지 않는다 — 신호만 넣어도 workflow 가 추가/삭제되면 반드시 hash 가 바뀌어 재시드가 강제되고,
  // 동일 hash 로 인한 stale skip(= marketTargets 미갱신)이 발생하지 않는다.
  // (신호와 타겟을 둘 다 넣으면 향후 둘의 의미가 갈릴 때 한쪽 누락이 hash 에 반영되지 않는 잠재 회귀가 남는다.)
  const configHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        play,
        appStore,
        firebaserc,
        aitAppName,
        hasPlayWorkflow,
        hasAppStoreWorkflow,
        hasAitWorkflow,
        hasWeb,
        opsManifestText,
        type,
        engine,
        displayName,
        seedVersion: SEED_VERSION,
      }),
    )
    .digest("hex");

  return {
    slug: name,
    displayName,
    repoFullName: repo.full_name,
    repoId: BigInt(repo.id),
    type,
    engine,
    isPublicRepo: !repo.private,
    firebaseProject: firebaserc?.projects?.default ?? null,
    playPackage: play?.packageName ?? null,
    iosBundle: appStoreBundleId ?? null,
    appleTeamId: appStoreAppleTeamId ?? null,
    iosSku: appStoreSku ?? null,
    aitAppName,
    marketTargets,
    opsManifest,
    opsManifestError,
    configHash,
    configSyncedAt: new Date(),
  };
}
