import type { Octokit } from "@/lib/github/app";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  toSourceMetadata,
  type SourceObservationResult,
  type SourcePersistenceMetadata,
} from "@/lib/github/source-observation";

export const REPOSITORY_DISCOVERY_CONTRACT_VERSION = "repository-discovery/v1";
export const REPOSITORY_REGISTRATION_SLO_MS = 5 * 60 * 1_000;
export const REPOSITORY_DISCOVERY_TERMINAL_SLO_MS = 10 * 60 * 1_000;
export const REPOSITORY_DISCOVERY_LEASE_MS = 90 * 1_000;
export const REPOSITORY_DISCOVERY_MAX_ATTEMPTS = 3;
export const REPOSITORY_DISCOVERY_MAX_TREE_ENTRIES = 20_000;
export const REPOSITORY_DISCOVERY_MAX_PACKAGE_FILES = 25;
export const REPOSITORY_DISCOVERY_MAX_CONFIG_FILES = 32;

const SHA_40 = /^[0-9a-f]{40}$/i;
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const PACKAGE_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

export type RepositoryDiscoveryReason =
  | "ARCHIVED"
  | "PUBLIC_REPOSITORY_REQUIRES_POLICY"
  | "EMPTY_REPOSITORY"
  | "DEFAULT_BRANCH_NOT_MAIN"
  | "REPOSITORY_IDENTITY_INVALID"
  | "REPOSITORY_ID_MISMATCH"
  | "REPOSITORY_FULL_NAME_MISMATCH"
  | "DEFAULT_BRANCH_MISMATCH"
  | "SOURCE_DRIFT"
  | "SOURCE_READ_UNAVAILABLE"
  | "TREE_INVALID"
  | "TREE_TRUNCATED"
  | "TREE_TOO_LARGE"
  | "SOURCE_FILE_UNREADABLE"
  | "TOO_MANY_DISCOVERY_FILES"
  | "INVALID_PACKAGE_JSON"
  | "NO_CANDIDATE"
  | "MULTIPLE_CANDIDATES"
  | "PACKAGE_MANAGER_MISSING"
  | "PACKAGE_MANAGER_AMBIGUOUS"
  | "BUILD_TARGET_MISSING"
  | "BUILD_IDENTITY_MISSING"
  | "BUILD_IDENTITY_AMBIGUOUS"
  | "PLATFORM_SDK_PRODUCER"
  | "APP_IDENTITY_CONFLICT"
  | "APP_MARKET_IDENTITY_CONFLICT"
  | "DISCOVERY_SLO_EXCEEDED";

export interface RepositoryTreeSnapshot {
  repoId: number;
  fullName: string;
  name: string;
  sourceSha: string;
  sourceRef: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  paths: readonly string[];
}

export type RepositoryTreeReadResult =
  | { status: "READY"; snapshot: RepositoryTreeSnapshot }
  | { status: "NEEDS_INPUT"; reasonCode: RepositoryDiscoveryReason }
  | { status: "STALE"; reasonCode: RepositoryDiscoveryReason; actualHeadSha?: string }
  | { status: "RETRY"; reasonCode: RepositoryDiscoveryReason };

export type RepositoryHeadReadResult =
  | { status: "READY"; sourceSha: string; sourceRef: string }
  | {
      status: "NEEDS_INPUT" | "RETRY";
      reasonCode: RepositoryDiscoveryReason;
    };

export type RepositoryDiscoverySourceReader = (
  path: string,
) => Promise<SourceObservationResult>;

export interface RepositoryDiscoveryBuildTarget {
  targetKey: string;
  stack: "react-native" | "godot";
  market: "google-play" | "app-store" | "apps-in-toss";
  packageId?: string;
  bundleId?: string;
  configuration?: Record<string, unknown>;
}

export interface RepositoryDiscoveryCandidate {
  profile: "react-native" | "godot";
  workingDirectory: string;
  markerPath: string;
}

interface DiscoveryBase {
  candidates: RepositoryDiscoveryCandidate[];
  sourceMetadata: SourcePersistenceMetadata[];
  candidateDigest: string;
  payload: Record<string, unknown>;
}

export type RepositoryDiscoveryResult =
  | (DiscoveryBase & {
      status: "ACTIVE";
      managementKind: "APP";
      reasonCode: null;
      appType: "APP" | "GAME";
      engine: "RN" | "GODOT";
      workflowCaller: {
        profile: "react-native" | "godot";
        packageManager: "npm" | "pnpm";
        workingDirectory: string;
      };
      buildTargets: RepositoryDiscoveryBuildTarget[];
    })
  | (DiscoveryBase & {
      status: "NEEDS_INPUT";
      managementKind: "UNCLASSIFIED";
      reasonCode: RepositoryDiscoveryReason;
    })
  | (DiscoveryBase & {
      status: "EXCLUDED";
      managementKind: "PLATFORM_PRODUCER";
      reasonCode: "PLATFORM_SDK_PRODUCER";
    });

type RepositoryDiscoveryUnfinished = RepositoryDiscoveryResult extends infer Result
  ? Result extends RepositoryDiscoveryResult
    ? Omit<Result, "candidateDigest" | "payload">
    : never
  : never;

type ParsedPackage = {
  path: string;
  directory: string;
  packageManager: unknown;
  dependencies: Record<string, unknown>;
  devDependencies: Record<string, unknown>;
  scripts: Record<string, unknown>;
  name: unknown;
};

type ExactTreeOctokit = {
  rest: {
    repos: Pick<Octokit["rest"]["repos"], "get" | "getCommit">;
    git: Pick<Octokit["rest"]["git"], "getTree">;
  };
};

type RepositoryHeadOctokit = {
  rest: {
    repos: Pick<Octokit["rest"]["repos"], "get" | "getCommit">;
  };
};

function repoParts(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split("/");
  if (
    parts.length !== 2
    || !REPO_SEGMENT.test(parts[0])
    || !REPO_SEGMENT.test(parts[1])
  ) return null;
  return { owner: parts[0], repo: parts[1] };
}

function httpStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function safeTreePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return parts.length <= 12 && parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function validRepoId(repoId: number): boolean {
  return Number.isSafeInteger(repoId) && repoId > 0;
}

/**
 * branch name은 provenance와 HEAD readback에만 쓰고, source 파일은 이후 exact SHA로 읽는다.
 * tree는 파일명 목록만 transient로 반환하며 DB payload에는 저장하지 않는다.
 */
export async function readExactRepositoryTree(
  octokit: ExactTreeOctokit,
  input: {
    repoId: number;
    fullName: string;
    expectedSourceSha?: string | null;
  },
): Promise<RepositoryTreeReadResult> {
  const identity = repoParts(input.fullName);
  if (!identity || !validRepoId(input.repoId)) {
    return { status: "NEEDS_INPUT", reasonCode: "REPOSITORY_IDENTITY_INVALID" };
  }
  if (input.expectedSourceSha && !SHA_40.test(input.expectedSourceSha)) {
    return { status: "NEEDS_INPUT", reasonCode: "REPOSITORY_IDENTITY_INVALID" };
  }

  let repository: {
    id?: unknown;
    full_name?: unknown;
    name?: unknown;
    default_branch?: unknown;
    private?: unknown;
    archived?: unknown;
  };
  try {
    repository = (await octokit.rest.repos.get(identity)).data;
  } catch (error) {
    const status = httpStatus(error);
    return {
      status: status === 404 ? "NEEDS_INPUT" : "RETRY",
      reasonCode: status === 404 ? "REPOSITORY_IDENTITY_INVALID" : "SOURCE_READ_UNAVAILABLE",
    };
  }
  if (repository.id !== input.repoId) {
    return { status: "NEEDS_INPUT", reasonCode: "REPOSITORY_ID_MISMATCH" };
  }
  if (
    typeof repository.full_name !== "string"
    || repository.full_name.toLowerCase() !== input.fullName.toLowerCase()
  ) {
    return { status: "NEEDS_INPUT", reasonCode: "REPOSITORY_FULL_NAME_MISMATCH" };
  }
  if (repository.archived === true) {
    return { status: "NEEDS_INPUT", reasonCode: "ARCHIVED" };
  }
  if (repository.private !== true) {
    return { status: "NEEDS_INPUT", reasonCode: "PUBLIC_REPOSITORY_REQUIRES_POLICY" };
  }
  if (typeof repository.default_branch !== "string" || repository.default_branch.length === 0) {
    return { status: "NEEDS_INPUT", reasonCode: "EMPTY_REPOSITORY" };
  }
  if (repository.default_branch !== "main") {
    return { status: "NEEDS_INPUT", reasonCode: "DEFAULT_BRANCH_NOT_MAIN" };
  }

  let commit: {
    sha?: unknown;
    commit?: { tree?: { sha?: unknown } };
  };
  try {
    commit = (await octokit.rest.repos.getCommit({
      ...identity,
      ref: repository.default_branch,
    })).data;
  } catch (error) {
    const status = httpStatus(error);
    return {
      status: status === 404 || status === 409 ? "NEEDS_INPUT" : "RETRY",
      reasonCode: status === 404 || status === 409 ? "EMPTY_REPOSITORY" : "SOURCE_READ_UNAVAILABLE",
    };
  }
  const sourceSha = typeof commit.sha === "string" ? commit.sha.toLowerCase() : "";
  const treeSha = typeof commit.commit?.tree?.sha === "string"
    ? commit.commit.tree.sha.toLowerCase()
    : "";
  if (!SHA_40.test(sourceSha) || !SHA_40.test(treeSha)) {
    return { status: "RETRY", reasonCode: "TREE_INVALID" };
  }
  if (
    input.expectedSourceSha
    && input.expectedSourceSha.toLowerCase() !== sourceSha
  ) {
    return { status: "STALE", reasonCode: "SOURCE_DRIFT", actualHeadSha: sourceSha };
  }

  let tree: { sha?: unknown; truncated?: unknown; tree?: unknown };
  try {
    tree = (await octokit.rest.git.getTree({
      ...identity,
      tree_sha: treeSha,
      recursive: "true",
    })).data;
  } catch {
    return { status: "RETRY", reasonCode: "SOURCE_READ_UNAVAILABLE" };
  }
  if (typeof tree.sha !== "string" || tree.sha.toLowerCase() !== treeSha) {
    return { status: "RETRY", reasonCode: "TREE_INVALID" };
  }
  if (tree.truncated === true) {
    return { status: "NEEDS_INPUT", reasonCode: "TREE_TRUNCATED" };
  }
  if (!Array.isArray(tree.tree)) {
    return { status: "RETRY", reasonCode: "TREE_INVALID" };
  }
  if (tree.tree.length > REPOSITORY_DISCOVERY_MAX_TREE_ENTRIES) {
    return { status: "NEEDS_INPUT", reasonCode: "TREE_TOO_LARGE" };
  }
  const paths: string[] = [];
  for (const entry of tree.tree as Array<{ path?: unknown; type?: unknown }>) {
    if (entry.type !== "blob") continue;
    if (!safeTreePath(entry.path)) {
      return { status: "NEEDS_INPUT", reasonCode: "TREE_INVALID" };
    }
    paths.push(entry.path);
  }

  return {
    status: "READY",
    snapshot: {
      repoId: input.repoId,
      fullName: repository.full_name,
      name: typeof repository.name === "string" ? repository.name : identity.repo,
      sourceSha,
      sourceRef: `refs/heads/${repository.default_branch}`,
      defaultBranch: repository.default_branch,
      private: true,
      archived: false,
      paths: [...new Set(paths)].sort(),
    },
  };
}

export async function readCurrentRepositoryHead(
  octokit: RepositoryHeadOctokit,
  input: { repoId: number; fullName: string },
): Promise<RepositoryHeadReadResult> {
  const identity = repoParts(input.fullName);
  if (!identity || !validRepoId(input.repoId)) {
    return { status: "NEEDS_INPUT", reasonCode: "REPOSITORY_IDENTITY_INVALID" };
  }
  try {
    const repository = (await octokit.rest.repos.get(identity)).data as {
      id?: unknown;
      full_name?: unknown;
      default_branch?: unknown;
      archived?: unknown;
      private?: unknown;
    };
    if (repository.id !== input.repoId) {
      return { status: "NEEDS_INPUT", reasonCode: "REPOSITORY_ID_MISMATCH" };
    }
    if (
      typeof repository.full_name !== "string"
      || repository.full_name.toLowerCase() !== input.fullName.toLowerCase()
    ) {
      return { status: "NEEDS_INPUT", reasonCode: "REPOSITORY_FULL_NAME_MISMATCH" };
    }
    if (repository.archived === true) {
      return { status: "NEEDS_INPUT", reasonCode: "ARCHIVED" };
    }
    if (repository.private !== true) {
      return { status: "NEEDS_INPUT", reasonCode: "PUBLIC_REPOSITORY_REQUIRES_POLICY" };
    }
    if (typeof repository.default_branch !== "string" || !repository.default_branch) {
      return { status: "NEEDS_INPUT", reasonCode: "EMPTY_REPOSITORY" };
    }
    if (repository.default_branch !== "main") {
      return { status: "NEEDS_INPUT", reasonCode: "DEFAULT_BRANCH_NOT_MAIN" };
    }
    const commit = (await octokit.rest.repos.getCommit({
      ...identity,
      ref: repository.default_branch,
    })).data as { sha?: unknown };
    if (typeof commit.sha !== "string" || !SHA_40.test(commit.sha)) {
      return { status: "RETRY", reasonCode: "SOURCE_READ_UNAVAILABLE" };
    }
    return {
      status: "READY",
      sourceSha: commit.sha.toLowerCase(),
      sourceRef: `refs/heads/${repository.default_branch}`,
    };
  } catch (error) {
    const status = httpStatus(error);
    return {
      status: status === 404 || status === 409 ? "NEEDS_INPUT" : "RETRY",
      reasonCode: status === 404 || status === 409 ? "EMPTY_REPOSITORY" : "SOURCE_READ_UNAVAILABLE",
    };
  }
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function pathIn(directory: string, suffix: string): string {
  return directory === "." ? suffix : `${directory}/${suffix}`;
}

function parentDirectories(directory: string): string[] {
  if (directory === ".") return ["."];
  const parts = directory.split("/");
  const result: string[] = [];
  for (let length = parts.length; length > 0; length--) {
    result.push(parts.slice(0, length).join("/"));
  }
  result.push(".");
  return result;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parsePackage(path: string, text: string): ParsedPackage | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const pkg = value as Record<string, unknown>;
    return {
      path,
      directory: directoryOf(path),
      packageManager: pkg.packageManager,
      dependencies: safeRecord(pkg.dependencies),
      devDependencies: safeRecord(pkg.devDependencies),
      scripts: safeRecord(pkg.scripts),
      name: pkg.name,
    };
  } catch {
    return null;
  }
}

function isPrimaryReactNativePackage(pkg: ParsedPackage): boolean {
  if (
    pkg.directory === "apps/ait"
    || pkg.directory.startsWith("apps/ait/")
    || pkg.directory === "ait"
    || pkg.directory.startsWith("ait/")
    || pkg.directory === "apps-in-toss"
    || pkg.directory.startsWith("apps-in-toss/")
  ) return false;
  return [pkg.dependencies, pkg.devDependencies].some((dependencies) =>
    typeof dependencies["react-native"] === "string" || typeof dependencies.expo === "string"
  );
}

function packageManagerFor(
  candidateDirectory: string,
  packages: readonly ParsedPackage[],
  paths: ReadonlySet<string>,
): { status: "FOUND"; value: "npm" | "pnpm" } | { status: "MISSING" | "AMBIGUOUS" } {
  const packageByDirectory = new Map(packages.map((pkg) => [pkg.directory, pkg]));
  const ancestors = parentDirectories(candidateDirectory);
  const signals = new Set<"npm" | "pnpm">();
  for (const directory of ancestors) {
    const pkg = packageByDirectory.get(directory);
    if (typeof pkg?.packageManager === "string") {
      if (/^pnpm@/.test(pkg.packageManager)) signals.add("pnpm");
      else if (/^npm@/.test(pkg.packageManager)) signals.add("npm");
    }
    if (paths.has(pathIn(directory, "pnpm-lock.yaml"))) signals.add("pnpm");
    if (paths.has(pathIn(directory, "package-lock.json"))) signals.add("npm");
    if (signals.size > 0) break;
  }
  if (signals.size === 0) {
    const pkg = packageByDirectory.get(candidateDirectory)
      ?? ancestors.map((directory) => packageByDirectory.get(directory)).find(Boolean);
    const scripts = Object.values(pkg?.scripts ?? {}).filter((value): value is string => typeof value === "string");
    const npm = scripts.some((script) => /(?:^|[;&|]\s*)npm\s+(?:run|exec|test|install)\b/.test(script));
    const pnpm = scripts.some((script) => /(?:^|[;&|]\s*)pnpm\s+/.test(script));
    if (npm) signals.add("npm");
    if (pnpm) signals.add("pnpm");
  }
  if (signals.size === 0) return { status: "MISSING" };
  if (signals.size > 1) return { status: "AMBIGUOUS" };
  return { status: "FOUND", value: [...signals][0] };
}

function parsePackageIds(texts: readonly string[], pattern: RegExp): string[] {
  const values = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim().replace(/^['"]|['"]$/g, "");
      if (value && PACKAGE_ID.test(value) && !/\.(?:test|tests)$/i.test(value)) values.add(value);
    }
  }
  return [...values].sort();
}

function parseGraniteAppNames(texts: readonly string[]): string[] {
  const values = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\bappName\s*:\s*["'`]([^"'`]{1,191})["'`]/g)) {
      values.add(match[1].trim());
    }
  }
  return [...values].filter(Boolean).sort();
}

function parseGodotExportPresets(text: string): Array<{
  platform: string;
  name: string;
  packageId?: string;
  bundleId?: string;
}> {
  const sections = new Map<string, Record<string, string>>();
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\[([^\]]+)\]$/)?.[1];
    if (heading) {
      section = heading;
      if (!sections.has(section)) sections.set(section, {});
      continue;
    }
    const entry = line.match(/^([^=]+)=(.*)$/);
    if (!entry || !section) continue;
    sections.get(section)![entry[1].trim()] = entry[2].trim().replace(/^"|"$/g, "");
  }
  const result: Array<{ platform: string; name: string; packageId?: string; bundleId?: string }> = [];
  for (const [key, values] of sections) {
    const preset = key.match(/^preset\.(\d+)$/)?.[1];
    if (!preset || /debug/i.test(values.name ?? "")) continue;
    const options = sections.get(`preset.${preset}.options`) ?? {};
    const packageId = options["package/unique_name"];
    const bundleId = options["application/bundle_identifier"];
    result.push({
      platform: values.platform ?? "",
      name: values.name ?? "",
      ...(packageId && PACKAGE_ID.test(packageId) ? { packageId } : {}),
      ...(bundleId && PACKAGE_ID.test(bundleId) ? { bundleId } : {}),
    });
  }
  return result;
}

function publicCandidate(candidate: RepositoryDiscoveryCandidate): RepositoryDiscoveryCandidate {
  return { ...candidate };
}

function resultPayload(input: {
  snapshot: RepositoryTreeSnapshot;
  status: RepositoryDiscoveryResult["status"];
  reasonCode: RepositoryDiscoveryReason | null;
  candidates: RepositoryDiscoveryCandidate[];
  sourceMetadata: SourcePersistenceMetadata[];
  workflowCaller?: { profile: string; packageManager: string; workingDirectory: string };
  buildTargets?: RepositoryDiscoveryBuildTarget[];
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    contractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
    repository: {
      id: input.snapshot.repoId,
      fullName: input.snapshot.fullName,
      sourceSha: input.snapshot.sourceSha,
      sourceRef: input.snapshot.sourceRef,
      private: input.snapshot.private,
    },
    status: input.status,
    reasonCode: input.reasonCode,
    candidates: input.candidates.map(publicCandidate),
    workflowCaller: input.workflowCaller ?? null,
    buildTargets: (input.buildTargets ?? []).map((target) => ({
      targetKey: target.targetKey,
      stack: target.stack,
      market: target.market,
      packageId: target.packageId ?? null,
      bundleId: target.bundleId ?? null,
      configuration: target.configuration ?? null,
    })),
    sources: input.sourceMetadata,
  };
}

function finish<T extends RepositoryDiscoveryUnfinished>(
  snapshot: RepositoryTreeSnapshot,
  input: T,
): T & Pick<RepositoryDiscoveryResult, "candidateDigest" | "payload"> {
  const candidateDigest = jsonDigest(input.candidates as unknown as JsonValue);
  const active = input.status === "ACTIVE"
    ? input as Omit<Extract<RepositoryDiscoveryResult, { status: "ACTIVE" }>, "candidateDigest" | "payload">
    : null;
  const payload = resultPayload({
    snapshot,
    status: input.status,
    reasonCode: input.reasonCode,
    candidates: input.candidates,
    sourceMetadata: input.sourceMetadata,
    ...(active
      ? { workflowCaller: active.workflowCaller, buildTargets: active.buildTargets }
      : {}),
  });
  return { ...input, candidateDigest, payload };
}

function needsInput(
  snapshot: RepositoryTreeSnapshot,
  reasonCode: RepositoryDiscoveryReason,
  candidates: RepositoryDiscoveryCandidate[],
  sourceMetadata: SourcePersistenceMetadata[],
): RepositoryDiscoveryResult {
  return finish(snapshot, {
    status: "NEEDS_INPUT" as const,
    managementKind: "UNCLASSIFIED" as const,
    reasonCode,
    candidates,
    sourceMetadata,
  });
}

/**
 * verified exact tree에서 allowlist 파일만 읽는다. text는 이 함수 안에서만 살아 있고
 * 결과에는 digest/size/blob SHA와 파생된 공개 build identity만 남는다.
 */
export async function discoverRepository(
  snapshot: RepositoryTreeSnapshot,
  readSource: RepositoryDiscoverySourceReader,
): Promise<RepositoryDiscoveryResult> {
  const pathSet = new Set(snapshot.paths);
  const packagePaths = snapshot.paths.filter((path) =>
    path.endsWith("package.json")
    && path.split("/").length <= 4
    && !path.split("/").includes("node_modules")
  );
  const godotPaths = snapshot.paths.filter((path) =>
    (path === "project.godot" || path.endsWith("/project.godot"))
    && path.split("/").length <= 3
  );
  const granitePaths = snapshot.paths.filter((path) =>
    path.endsWith("granite.config.ts") && path.split("/").length <= 5
  );
  const configPaths = new Set<string>([...packagePaths, ...godotPaths, ...granitePaths]);
  if (packagePaths.length > REPOSITORY_DISCOVERY_MAX_PACKAGE_FILES) {
    return needsInput(snapshot, "TOO_MANY_DISCOVERY_FILES", [], []);
  }

  const sourceMetadata: SourcePersistenceMetadata[] = [];
  const texts = new Map<string, string>();
  const readPaths = async (paths: readonly string[]): Promise<RepositoryDiscoveryReason | null> => {
    for (const path of [...new Set(paths)].sort()) {
      if (texts.has(path)) continue;
      if (texts.size >= REPOSITORY_DISCOVERY_MAX_CONFIG_FILES) return "TOO_MANY_DISCOVERY_FILES";
      const source = await readSource(path);
      sourceMetadata.push(toSourceMetadata(source));
      if (source.status !== "PRESENT") return "SOURCE_FILE_UNREADABLE";
      texts.set(path, source.text);
    }
    return null;
  };

  const initialReadError = await readPaths([...configPaths]);
  if (initialReadError) return needsInput(snapshot, initialReadError, [], sourceMetadata);

  const packages: ParsedPackage[] = [];
  for (const path of packagePaths) {
    const parsed = parsePackage(path, texts.get(path)!);
    if (!parsed) return needsInput(snapshot, "INVALID_PACKAGE_JSON", [], sourceMetadata);
    packages.push(parsed);
  }

  const rootPackage = packages.find((pkg) => pkg.path === "package.json");
  if (
    snapshot.fullName.toLowerCase() === "seorilabs/platform"
    && rootPackage?.name === "seorilabs-platform"
    && pathSet.has("spec/openapi.yaml")
  ) {
    return finish(snapshot, {
      status: "EXCLUDED" as const,
      managementKind: "PLATFORM_PRODUCER" as const,
      reasonCode: "PLATFORM_SDK_PRODUCER" as const,
      candidates: [],
      sourceMetadata,
    });
  }

  const candidates: RepositoryDiscoveryCandidate[] = [
    ...packages.filter(isPrimaryReactNativePackage).map((pkg) => ({
      profile: "react-native" as const,
      workingDirectory: pkg.directory,
      markerPath: pkg.path,
    })),
    ...godotPaths.map((path) => ({
      profile: "godot" as const,
      workingDirectory: directoryOf(path),
      markerPath: path,
    })),
  ].sort((left, right) => left.markerPath.localeCompare(right.markerPath));

  if (candidates.length === 0) {
    return needsInput(snapshot, "NO_CANDIDATE", candidates, sourceMetadata);
  }
  if (candidates.length !== 1) {
    return needsInput(snapshot, "MULTIPLE_CANDIDATES", candidates, sourceMetadata);
  }
  const candidate = candidates[0];
  const packageManager = packageManagerFor(candidate.workingDirectory, packages, pathSet);
  if (packageManager.status !== "FOUND") {
    return needsInput(
      snapshot,
      packageManager.status === "MISSING" ? "PACKAGE_MANAGER_MISSING" : "PACKAGE_MANAGER_AMBIGUOUS",
      candidates,
      sourceMetadata,
    );
  }

  const stack = candidate.profile;
  const buildTargets: RepositoryDiscoveryBuildTarget[] = [];
  const buildSourcePaths: string[] = [];
  if (candidate.profile === "react-native") {
    const androidPaths = [
      pathIn(candidate.workingDirectory, "android/app/build.gradle"),
      pathIn(candidate.workingDirectory, "android/app/build.gradle.kts"),
    ].filter((path) => pathSet.has(path));
    const iosPrefix = pathIn(candidate.workingDirectory, "ios/");
    const iosPaths = snapshot.paths.filter((path) =>
      path.startsWith(iosPrefix)
      && /\.xcodeproj\/project\.pbxproj$/.test(path)
      && path.split("/").length <= iosPrefix.split("/").length + 3
    );
    buildSourcePaths.push(...androidPaths, ...iosPaths);
    const buildReadError = await readPaths(buildSourcePaths);
    if (buildReadError) return needsInput(snapshot, buildReadError, candidates, sourceMetadata);
    const androidIds = parsePackageIds(
      androidPaths.map((path) => texts.get(path)!),
      /\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/g,
    );
    const iosIds = parsePackageIds(
      iosPaths.map((path) => texts.get(path)!),
      /\bPRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g,
    );
    if (androidIds.length > 1 || iosIds.length > 1) {
      return needsInput(snapshot, "BUILD_IDENTITY_AMBIGUOUS", candidates, sourceMetadata);
    }
    if (androidPaths.length > 0) {
      if (!androidIds[0]) {
        return needsInput(snapshot, "BUILD_IDENTITY_MISSING", candidates, sourceMetadata);
      }
      buildTargets.push({
        targetKey: "android",
        stack,
        market: "google-play",
        ...(androidIds[0] ? { packageId: androidIds[0] } : {}),
      });
    }
    if (iosPaths.length > 0) {
      if (!iosIds[0]) {
        return needsInput(snapshot, "BUILD_IDENTITY_MISSING", candidates, sourceMetadata);
      }
      buildTargets.push({
        targetKey: "ios",
        stack,
        market: "app-store",
        ...(iosIds[0] ? { bundleId: iosIds[0] } : {}),
      });
    }
  } else {
    const exportPath = pathIn(candidate.workingDirectory, "export_presets.cfg");
    const buildEnvPath = pathIn(candidate.workingDirectory, "build.env");
    const godotBuildPaths = [exportPath, buildEnvPath].filter((path) => pathSet.has(path));
    buildSourcePaths.push(...godotBuildPaths);
    const buildReadError = await readPaths(godotBuildPaths);
    if (buildReadError) return needsInput(snapshot, buildReadError, candidates, sourceMetadata);
    const presets = pathSet.has(exportPath) ? parseGodotExportPresets(texts.get(exportPath)!) : [];
    const androidIds = [...new Set(presets.filter((preset) => preset.platform === "Android" && preset.packageId).map((preset) => preset.packageId!))];
    const iosIds = [...new Set(presets.filter((preset) => preset.platform === "iOS" && preset.bundleId).map((preset) => preset.bundleId!))];
    if (androidIds.length > 1 || iosIds.length > 1) {
      return needsInput(snapshot, "BUILD_IDENTITY_AMBIGUOUS", candidates, sourceMetadata);
    }
    const buildEnv = pathSet.has(buildEnvPath) ? texts.get(buildEnvPath)! : "";
    const hasAndroidTarget = presets.some((preset) => preset.platform === "Android")
      || /^AAB_PATH=/m.test(buildEnv);
    const hasIosTarget = presets.some((preset) => preset.platform === "iOS")
      || pathSet.has(pathIn(candidate.workingDirectory, "ios/ci_scripts/ci_post_clone.sh"));
    if ((hasAndroidTarget && !androidIds[0]) || (hasIosTarget && !iosIds[0])) {
      return needsInput(snapshot, "BUILD_IDENTITY_MISSING", candidates, sourceMetadata);
    }
    if (hasAndroidTarget) {
      buildTargets.push({
        targetKey: "android",
        stack,
        market: "google-play",
        ...(androidIds[0] ? { packageId: androidIds[0] } : {}),
      });
    }
    if (hasIosTarget) {
      buildTargets.push({
        targetKey: "ios",
        stack,
        market: "app-store",
        ...(iosIds[0] ? { bundleId: iosIds[0] } : {}),
      });
    }
  }

  const graniteReadError = await readPaths(granitePaths);
  if (graniteReadError) return needsInput(snapshot, graniteReadError, candidates, sourceMetadata);
  if (granitePaths.length > 0) {
    const appNames = parseGraniteAppNames(granitePaths.map((path) => texts.get(path)!));
    if (appNames.length > 1) {
      return needsInput(snapshot, "BUILD_IDENTITY_AMBIGUOUS", candidates, sourceMetadata);
    }
    if (!appNames[0]) {
      return needsInput(snapshot, "BUILD_IDENTITY_MISSING", candidates, sourceMetadata);
    }
    buildTargets.push({
      targetKey: "ait",
      stack,
      market: "apps-in-toss",
      ...(appNames[0] ? { configuration: { appName: appNames[0] } } : {}),
    });
  }

  if (buildTargets.length === 0) {
    return needsInput(snapshot, "BUILD_TARGET_MISSING", candidates, sourceMetadata);
  }

  return finish(snapshot, {
    status: "ACTIVE" as const,
    managementKind: "APP" as const,
    reasonCode: null,
    candidates,
    sourceMetadata,
    appType: candidate.profile === "godot" ? "GAME" as const : "APP" as const,
    engine: candidate.profile === "godot" ? "GODOT" as const : "RN" as const,
    workflowCaller: {
      profile: candidate.profile,
      packageManager: packageManager.value,
      workingDirectory: candidate.workingDirectory,
    },
    buildTargets: buildTargets.sort((left, right) => left.targetKey.localeCompare(right.targetKey)),
  });
}

export function repositoryDiscoverySloState(input: {
  createdAt: Date;
  status: "QUEUED" | "RUNNING" | "MANAGED" | "NEEDS_INPUT" | "EXCLUDED" | "STALE" | "FAILED";
  now: Date;
}): "WITHIN_SLO" | "TERMINAL" | "OVERDUE" {
  if (["MANAGED", "NEEDS_INPUT", "EXCLUDED", "STALE", "FAILED"].includes(input.status)) {
    return "TERMINAL";
  }
  return input.now.getTime() - input.createdAt.getTime() >= REPOSITORY_DISCOVERY_TERMINAL_SLO_MS
    ? "OVERDUE"
    : "WITHIN_SLO";
}
