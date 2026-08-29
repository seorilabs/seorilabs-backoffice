import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

import type { Octokit } from "@/lib/github/app";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  toSourceMetadata,
  type SourceObservationResult,
  type SourcePersistenceMetadata,
} from "@/lib/github/source-observation";
import {
  repositoryClassificationPolicy,
  repositoryPublicDiscoveryAllowed,
  type RepositoryClassification,
  type RepositoryClassificationDirective,
} from "@/lib/control-plane/repository-classification";
import type { WorkflowCaller } from "@/lib/control-plane/contracts";

// v6: v5 배포 뒤 추가된 Capacitor/AIT profile과 application-package
// disambiguation을 새 generation으로 다시 관측한다. 탐지 의미론을 바꾸고도
// version을 유지하면 hourly backfill이 같은 terminal run을 replay한다.
export const REPOSITORY_DISCOVERY_CONTRACT_VERSION = "repository-discovery/v6";
export const REPOSITORY_REGISTRATION_SLO_MS = 5 * 60 * 1_000;
export const REPOSITORY_DISCOVERY_TERMINAL_SLO_MS = 10 * 60 * 1_000;
export const REPOSITORY_DISCOVERY_LEASE_MS = 90 * 1_000;
export const REPOSITORY_DISCOVERY_MAX_ATTEMPTS = 3;
export const REPOSITORY_DISCOVERY_MAX_TREE_ENTRIES = 20_000;
export const REPOSITORY_DISCOVERY_MAX_TREE_PATH_DEPTH = 64;
export const REPOSITORY_DISCOVERY_MAX_PACKAGE_FILES = 25;
export const REPOSITORY_DISCOVERY_MAX_CONFIG_FILES = 96;
export const REPOSITORY_DISCOVERY_MAX_LOCKFILE_BYTES = 1024 * 1024;

const SHA_40 = /^[0-9a-f]{40}$/i;
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const PACKAGE_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

export type RepositoryDiscoveryReason =
  | "ARCHIVED"
  | "FORK_REPOSITORY"
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
  | "CLASSIFICATION_CANDIDATE_INVALID"
  | "PACKAGE_MANAGER_MISSING"
  | "PACKAGE_MANAGER_AMBIGUOUS"
  | "BUILD_TARGET_MISSING"
  | "BUILD_IDENTITY_MISSING"
  | "BUILD_IDENTITY_AMBIGUOUS"
  | "PLATFORM_SDK_PRODUCER"
  | "PLATFORM_PRODUCER_IDENTITY_INVALID"
  | "INFRASTRUCTURE_REPOSITORY"
  | "NON_PRODUCT_REPOSITORY"
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
  fork: boolean;
  archived: boolean;
  paths: readonly string[];
  gitlinkPaths?: readonly string[];
}

export type RepositoryTreeReadResult =
  | { status: "READY"; snapshot: RepositoryTreeSnapshot }
  | {
      status: "CLASSIFIED";
      classification: "INFRA_REPO" | "EXCLUDED";
      reasonCode: "INFRASTRUCTURE_REPOSITORY" | "NON_PRODUCT_REPOSITORY";
    }
  | { status: "NEEDS_INPUT"; reasonCode: RepositoryDiscoveryReason }
  | {
      status: "STALE";
      reasonCode: RepositoryDiscoveryReason;
      actualHeadSha: string;
      private: boolean;
      fork: boolean;
    }
  | { status: "RETRY"; reasonCode: RepositoryDiscoveryReason };

export type RepositoryHeadReadResult =
  | { status: "READY"; sourceSha: string; sourceRef: string }
  | {
      status: "NEEDS_INPUT" | "RETRY";
      reasonCode: RepositoryDiscoveryReason;
    };

export type RepositoryDiscoverySourceReader = (
  path: string,
  maxBytes?: number,
) => Promise<SourceObservationResult>;

export interface RepositoryDiscoveryBuildTarget {
  targetKey: string;
  stack: "react-native" | "capacitor" | "ait-web" | "godot";
  market: "google-play" | "app-store" | "apps-in-toss";
  packageId: string | null;
  bundleId: string | null;
  configuration: Record<string, unknown> | null;
}

export interface RepositoryDiscoveryCandidate {
  profile: "react-native" | "capacitor" | "ait-web" | "godot";
  workingDirectory: string;
  markerPath: string;
}

export type RepositoryPlatformConsumerObservation =
  | {
      schemaVersion: 1;
      sourceSha: string;
      integration: "SDK";
      artifactKind: "TYPESCRIPT" | "GDSCRIPT";
      observedVersion: string;
      observedDigest: null;
      contractRevision: null;
      evidenceDigest: string;
      lockIntegrity?: string;
      releaseAssetUrl?: string;
      treeChecksum?: string;
    }
  | {
      schemaVersion: 1;
      sourceSha: string;
      integration: "CUSTOM_HTTP" | "MISSING";
      evidenceDigest: string;
    };

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
      classification: "PRODUCT_APP";
      reasonCode: null;
      appType: "APP" | "GAME";
      engine: "RN" | "GODOT";
      workflowCaller: WorkflowCaller;
      buildTargets: RepositoryDiscoveryBuildTarget[];
      platformConsumer: RepositoryPlatformConsumerObservation;
    })
  | (DiscoveryBase & {
      status: "NEEDS_INPUT";
      managementKind: "UNCLASSIFIED";
      classification: null;
      reasonCode: RepositoryDiscoveryReason;
    })
  | (DiscoveryBase & {
      status: "EXCLUDED";
      managementKind: "UNCLASSIFIED" | "PLATFORM_PRODUCER";
      classification: "INFRA_REPO" | "PLATFORM_PRODUCER" | "EXCLUDED";
      reasonCode: "PLATFORM_SDK_PRODUCER" | "INFRASTRUCTURE_REPOSITORY" | "NON_PRODUCT_REPOSITORY";
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

type PlatformPackageLock = {
  version: string;
  integrity: string;
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
  return parts.length <= REPOSITORY_DISCOVERY_MAX_TREE_PATH_DEPTH
    && parts.every((part) => part.length > 0 && part !== "." && part !== "..");
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
    classificationDecision?: RepositoryClassificationDirective | null;
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
    fork?: unknown;
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
    typeof repository.archived !== "boolean"
    || typeof repository.private !== "boolean"
    || typeof repository.fork !== "boolean"
  ) {
    return { status: "NEEDS_INPUT", reasonCode: "REPOSITORY_IDENTITY_INVALID" };
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
  const classificationPolicy = input.classificationDecision
    ? null
    : repositoryClassificationPolicy(input.fullName);
  if (
    classificationPolicy
    && (classificationPolicy.classification === "INFRA_REPO"
      || classificationPolicy.classification === "EXCLUDED")
  ) {
    return {
      status: "CLASSIFIED",
      classification: classificationPolicy.classification,
      reasonCode: classificationPolicy.classification === "INFRA_REPO"
        ? "INFRASTRUCTURE_REPOSITORY"
        : "NON_PRODUCT_REPOSITORY",
    };
  }
  const explicitPolicy = input.classificationDecision !== null
    && input.classificationDecision !== undefined;
  if (
    repository.private !== true
    && !repositoryPublicDiscoveryAllowed(input.fullName)
    && !explicitPolicy
  ) {
    return { status: "NEEDS_INPUT", reasonCode: "PUBLIC_REPOSITORY_REQUIRES_POLICY" };
  }
  if (
    input.classificationDecision?.classification === "INFRA_REPO"
    || input.classificationDecision?.classification === "EXCLUDED"
  ) {
    return {
      status: "CLASSIFIED",
      classification: input.classificationDecision.classification,
      reasonCode: input.classificationDecision.classification === "INFRA_REPO"
        ? "INFRASTRUCTURE_REPOSITORY"
        : "NON_PRODUCT_REPOSITORY",
    };
  }
  if (repository.fork) {
    return { status: "NEEDS_INPUT", reasonCode: "FORK_REPOSITORY" };
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
    return {
      status: "STALE",
      reasonCode: "SOURCE_DRIFT",
      actualHeadSha: sourceSha,
      private: repository.private,
      fork: repository.fork,
    };
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
  const gitlinkPaths: string[] = [];
  for (const entry of tree.tree as Array<{ path?: unknown; type?: unknown }>) {
    if (entry.type === "tree") continue;
    if (!safeTreePath(entry.path)) {
      return { status: "NEEDS_INPUT", reasonCode: "TREE_INVALID" };
    }
    if (entry.type === "blob") paths.push(entry.path);
    else if (entry.type === "commit") gitlinkPaths.push(entry.path);
    else return { status: "NEEDS_INPUT", reasonCode: "TREE_INVALID" };
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
      private: repository.private === true,
      fork: repository.fork,
      archived: false,
      paths: [...new Set(paths)].sort(),
      gitlinkPaths: [...new Set(gitlinkPaths)].sort(),
    },
  };
}

export async function readCurrentRepositoryHead(
  octokit: RepositoryHeadOctokit,
  input: { repoId: number; fullName: string; publicDiscoveryApproved?: boolean },
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
      fork?: unknown;
    };
    if (repository.id !== input.repoId) {
      return { status: "NEEDS_INPUT", reasonCode: "REPOSITORY_ID_MISMATCH" };
    }
    if (
      typeof repository.archived !== "boolean"
      || typeof repository.private !== "boolean"
      || typeof repository.fork !== "boolean"
    ) {
      return { status: "NEEDS_INPUT", reasonCode: "REPOSITORY_IDENTITY_INVALID" };
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
    if (repository.fork) {
      return { status: "NEEDS_INPUT", reasonCode: "FORK_REPOSITORY" };
    }
    const classificationPolicy = repositoryClassificationPolicy(input.fullName);
    const centrallyClassifiedNonProduct = classificationPolicy?.classification === "INFRA_REPO"
      || classificationPolicy?.classification === "EXCLUDED";
    if (
      repository.private !== true
      && !repositoryPublicDiscoveryAllowed(input.fullName)
      && !centrallyClassifiedNonProduct
      && input.publicDiscoveryApproved !== true
    ) {
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

function relativeDirectory(from: string, to: string): string | null {
  if (from === ".") return to;
  if (from === to) return ".";
  return to.startsWith(`${from}/`) ? to.slice(from.length + 1) : null;
}

function packageLockPath(
  candidateDirectory: string,
  packageManager: "npm" | "pnpm",
  paths: ReadonlySet<string>,
): string | null {
  const name = packageManager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
  for (const directory of parentDirectories(candidateDirectory)) {
    const path = pathIn(directory, name);
    if (paths.has(path)) return path;
  }
  return null;
}

function exactPlatformVersion(value: unknown): string | null {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

function platformPackageSpec(pkg: ParsedPackage): unknown {
  return pkg.dependencies["@seorilabs/platform-sdk"]
    ?? pkg.devDependencies["@seorilabs/platform-sdk"];
}

function validPackageIntegrity(value: unknown): value is string {
  return typeof value === "string"
    && /^(?:sha256-[A-Za-z0-9+/]{43}=|sha512-[A-Za-z0-9+/]{86}==)$/.test(value);
}

function normalizedLockVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(?:npm:)?(\d+\.\d+\.\d+)(?:\([^)]*\))?$/.exec(value);
  return match?.[1] ?? null;
}

function parsePnpmPlatformLock(
  text: string,
  lockPath: string,
  candidateDirectory: string,
): PlatformPackageLock | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { maxAliasCount: 20 });
  } catch {
    return null;
  }
  const root = safeRecord(parsed);
  const lockDirectory = directoryOf(lockPath);
  const importerKey = relativeDirectory(lockDirectory, candidateDirectory);
  if (importerKey === null) return null;
  const importer = safeRecord(safeRecord(root.importers)[importerKey]);
  const dependency = safeRecord(importer.dependencies)["@seorilabs/platform-sdk"]
    ?? safeRecord(importer.devDependencies)["@seorilabs/platform-sdk"];
  const dependencyRecord = safeRecord(dependency);
  const version = normalizedLockVersion(
    typeof dependency === "string" ? dependency : dependencyRecord.version,
  );
  if (!version) return null;

  const packages = safeRecord(root.packages);
  const packageEntry = Object.entries(packages).find(([key]) => {
    const normalized = key.replace(/^\//, "");
    return normalized === `@seorilabs/platform-sdk@${version}`
      || normalized.startsWith(`@seorilabs/platform-sdk@${version}(`);
  })?.[1];
  const packageRecord = safeRecord(packageEntry);
  const resolution = safeRecord(packageRecord.resolution);
  const integrity = resolution.integrity ?? dependencyRecord.integrity;
  if (!validPackageIntegrity(integrity)) return null;
  return { version, integrity };
}

function parseNpmPlatformLock(
  text: string,
  lockPath: string,
  candidateDirectory: string,
): PlatformPackageLock | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const root = safeRecord(parsed);
  const lockDirectory = directoryOf(lockPath);
  const relative = relativeDirectory(lockDirectory, candidateDirectory);
  if (relative === null) return null;
  const packagePath = relative === "."
    ? "node_modules/@seorilabs/platform-sdk"
    : `${relative}/node_modules/@seorilabs/platform-sdk`;
  const packageRecord = safeRecord(safeRecord(root.packages)[packagePath]);
  const version = exactPlatformVersion(packageRecord.version);
  const integrity = packageRecord.integrity;
  if (!version || !validPackageIntegrity(integrity)) return null;
  return { version, integrity };
}

function updateHashWithLength(hash: ReturnType<typeof createHash>, value: string): void {
  const content = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(content.length));
  hash.update(length);
  hash.update(content);
}

function vendoredTreeChecksum(files: Array<{ path: string; text: string }>): string {
  const hash = createHash("sha256");
  hash.update(Buffer.from("seorilabs-vendored-tree-v1\0", "utf8"));
  for (const file of [...files].sort((left, right) => (
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"))
  ))) {
    updateHashWithLength(hash, file.path);
    updateHashWithLength(hash, file.text);
  }
  return hash.digest("hex");
}

function platformEvidenceDigest(input: Record<string, unknown>): string {
  return jsonDigest(input as JsonValue);
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
  return [pkg.dependencies, pkg.devDependencies].some((dependencies) =>
    typeof dependencies["react-native"] === "string" || typeof dependencies.expo === "string"
  );
}

function isCapacitorPackage(pkg: ParsedPackage): boolean {
  return [pkg.dependencies, pkg.devDependencies].some((dependencies) =>
    typeof dependencies["@capacitor/core"] === "string"
  );
}

function isAppsInTossWebPackage(pkg: ParsedPackage): boolean {
  return [pkg.dependencies, pkg.devDependencies].some((dependencies) =>
    typeof dependencies["@apps-in-toss/web-framework"] === "string"
  );
}

function isAppsInTossPackage(pkg: ParsedPackage): boolean {
  const deliveryDirectory = pkg.directory === "apps/ait"
    || pkg.directory.startsWith("apps/ait/")
    || pkg.directory === "ait"
    || pkg.directory.startsWith("ait/")
    || pkg.directory === "apps-in-toss"
    || pkg.directory.startsWith("apps-in-toss/");
  return deliveryDirectory || [pkg.dependencies, pkg.devDependencies].some((dependencies) => (
    typeof dependencies["@apps-in-toss/framework"] === "string"
    || typeof dependencies["@granite-js/react-native"] === "string"
  ));
}

function hasApplicationPackageMarker(
  directory: string,
  paths: ReadonlySet<string>,
): boolean {
  if ([
    "android/app/build.gradle",
    "android/app/build.gradle.kts",
    "app.json",
    "app.config.js",
    "app.config.ts",
    "granite.config.ts",
    "apps-in-toss.config.ts",
  ].some((suffix) => paths.has(pathIn(directory, suffix)))) return true;
  const iosPrefix = `${pathIn(directory, "ios/")}`;
  return [...paths].some((path) => (
    path.startsWith(iosPrefix) && /\.xcodeproj\/project\.pbxproj$/.test(path)
  ));
}

/**
 * 같은 profile의 workspace library가 react-native/AIT peer dependency만 가진
 * 경우 실제 application package와 중복 후보가 되지 않게 한다. marker가 정확히
 * 하나일 때만 좁히며 0개/여러 개면 기존 fail-closed 후보를 유지한다.
 */
function preferApplicationPackage(
  packages: readonly ParsedPackage[],
  paths: ReadonlySet<string>,
): ParsedPackage[] {
  const applications = packages.filter((pkg) => hasApplicationPackageMarker(pkg.directory, paths));
  return applications.length === 1 ? applications : [...packages];
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
  classification: RepositoryClassification | null;
  candidates: RepositoryDiscoveryCandidate[];
  sourceMetadata: SourcePersistenceMetadata[];
  workflowCaller?: WorkflowCaller;
  buildTargets?: RepositoryDiscoveryBuildTarget[];
  platformConsumer?: RepositoryPlatformConsumerObservation;
}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    contractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
    repository: {
      id: input.snapshot.repoId,
      fullName: input.snapshot.fullName,
      sourceSha: input.snapshot.sourceSha,
      sourceRef: input.snapshot.sourceRef,
      private: input.snapshot.private,
      fork: input.snapshot.fork,
    },
    status: input.status,
    reasonCode: input.reasonCode,
    classification: input.classification,
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
    platformConsumer: input.platformConsumer ?? null,
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
    classification: input.classification,
    candidates: input.candidates,
    sourceMetadata: input.sourceMetadata,
    ...(active
      ? {
          workflowCaller: active.workflowCaller,
          buildTargets: active.buildTargets,
          platformConsumer: active.platformConsumer,
        }
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
    classification: null,
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
  classificationDecision: RepositoryClassificationDirective | null = null,
): Promise<RepositoryDiscoveryResult> {
  if (snapshot.fork) return needsInput(snapshot, "FORK_REPOSITORY", [], []);
  const pathSet = new Set(snapshot.paths);
  const classificationPolicy = classificationDecision
    ? null
    : repositoryClassificationPolicy(snapshot.fullName);
  if (
    classificationDecision?.classification === "INFRA_REPO"
    || classificationDecision?.classification === "EXCLUDED"
  ) {
    return finish(snapshot, {
      status: "EXCLUDED" as const,
      managementKind: "UNCLASSIFIED" as const,
      classification: classificationDecision.classification,
      reasonCode: classificationDecision.classification === "INFRA_REPO"
        ? "INFRASTRUCTURE_REPOSITORY" as const
        : "NON_PRODUCT_REPOSITORY" as const,
      candidates: [],
      sourceMetadata: [],
    });
  }
  if (
    classificationPolicy
    && classificationPolicy.classification !== "PRODUCT_APP_CANDIDATE"
    && classificationPolicy.classification !== "PLATFORM_PRODUCER"
  ) {
    return finish(snapshot, {
      status: "EXCLUDED" as const,
      managementKind: "UNCLASSIFIED" as const,
      classification: classificationPolicy.classification,
      reasonCode: classificationPolicy.reasonCode!,
      candidates: [],
      sourceMetadata: [],
    });
  }
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
  const appsInTossConfigPaths = snapshot.paths.filter((path) =>
    path.endsWith("apps-in-toss.config.ts") && path.split("/").length <= 5
  );
  const configPaths = new Set<string>([
    ...packagePaths,
    ...godotPaths,
    ...granitePaths,
    ...appsInTossConfigPaths,
  ]);
  if (packagePaths.length > REPOSITORY_DISCOVERY_MAX_PACKAGE_FILES) {
    return needsInput(snapshot, "TOO_MANY_DISCOVERY_FILES", [], []);
  }

  const sourceMetadata: SourcePersistenceMetadata[] = [];
  const texts = new Map<string, string>();
  const readPaths = async (
    paths: readonly string[],
    maxBytes?: number,
  ): Promise<RepositoryDiscoveryReason | null> => {
    for (const path of [...new Set(paths)].sort()) {
      if (texts.has(path)) continue;
      if (texts.size >= REPOSITORY_DISCOVERY_MAX_CONFIG_FILES) return "TOO_MANY_DISCOVERY_FILES";
      const source = await readSource(path, maxBytes);
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
  const platformProducerRequested = classificationDecision?.classification === "PLATFORM_PRODUCER"
    || classificationPolicy?.classification === "PLATFORM_PRODUCER";
  if (
    platformProducerRequested
    && rootPackage?.name === "seorilabs-platform"
    && pathSet.has("spec/openapi.yaml")
  ) {
    return finish(snapshot, {
      status: "EXCLUDED" as const,
      managementKind: "PLATFORM_PRODUCER" as const,
      classification: "PLATFORM_PRODUCER" as const,
      reasonCode: "PLATFORM_SDK_PRODUCER" as const,
      candidates: [],
      sourceMetadata,
    });
  }
  if (platformProducerRequested) {
    return needsInput(snapshot, "PLATFORM_PRODUCER_IDENTITY_INVALID", [], sourceMetadata);
  }

  const reactNativePackages = packages
    .filter(isPrimaryReactNativePackage)
    .filter((pkg) => !isCapacitorPackage(pkg));
  const nonDeliveryReactNativePackages = reactNativePackages.some((pkg) => !isAppsInTossPackage(pkg))
    ? reactNativePackages.filter((pkg) => !isAppsInTossPackage(pkg))
    : reactNativePackages;
  const primaryReactNativePackages = preferApplicationPackage(nonDeliveryReactNativePackages, pathSet);
  const capacitorPackages = preferApplicationPackage(packages.filter(isCapacitorPackage), pathSet);
  const appsInTossWebPackages = packages.filter((pkg) => (
    isAppsInTossWebPackage(pkg) && !isCapacitorPackage(pkg) && !isPrimaryReactNativePackage(pkg)
  ));
  const primaryJsCandidates: RepositoryDiscoveryCandidate[] = [
    ...primaryReactNativePackages.map((pkg) => ({
      profile: "react-native" as const,
      workingDirectory: pkg.directory,
      markerPath: pkg.path,
    })),
    ...capacitorPackages.map((pkg) => ({
      profile: "capacitor" as const,
      workingDirectory: pkg.directory,
      markerPath: pkg.path,
    })),
  ];
  const godotCandidates: RepositoryDiscoveryCandidate[] = godotPaths.map((path) => ({
    profile: "godot" as const,
    workingDirectory: directoryOf(path),
    markerPath: path,
  }));
  const primaryNonAitCandidates = [...primaryJsCandidates, ...godotCandidates];
  const fallbackAitWebCandidates: RepositoryDiscoveryCandidate[] = primaryNonAitCandidates.length === 0
    ? preferApplicationPackage(appsInTossWebPackages, pathSet).map((pkg) => ({
        profile: "ait-web" as const,
        workingDirectory: pkg.directory,
        markerPath: pkg.path,
      }))
    : [];
  const candidates: RepositoryDiscoveryCandidate[] = [
    ...primaryNonAitCandidates,
    ...fallbackAitWebCandidates,
  ].sort((left, right) => left.markerPath.localeCompare(right.markerPath));

  if (candidates.length === 0) {
    return needsInput(snapshot, "NO_CANDIDATE", candidates, sourceMetadata);
  }
  const selectedMarker = classificationDecision?.classification === "PRODUCT_APP"
    ? classificationDecision.candidateMarkerPath
    : null;
  const selectedCandidate = selectedMarker
    ? candidates.find((item) => item.markerPath === selectedMarker)
    : null;
  if (selectedMarker && !selectedCandidate) {
    return needsInput(snapshot, "CLASSIFICATION_CANDIDATE_INVALID", candidates, sourceMetadata);
  }
  if (!selectedCandidate && candidates.length !== 1) {
    return needsInput(snapshot, "MULTIPLE_CANDIDATES", candidates, sourceMetadata);
  }
  const candidate = selectedCandidate ?? candidates[0];
  let workflowCaller: WorkflowCaller;
  let platformConsumer: RepositoryPlatformConsumerObservation;
  if (candidate.profile !== "godot") {
    const packageManager = packageManagerFor(candidate.workingDirectory, packages, pathSet);
    if (packageManager.status !== "FOUND") {
      return needsInput(
        snapshot,
        packageManager.status === "MISSING" ? "PACKAGE_MANAGER_MISSING" : "PACKAGE_MANAGER_AMBIGUOUS",
        candidates,
        sourceMetadata,
      );
    }
    workflowCaller = {
      profile: candidate.profile,
      packageManager: packageManager.value,
      workingDirectory: candidate.workingDirectory,
    };
    const pkg = packages.find((entry) => entry.path === candidate.markerPath);
    const declaredSpec = pkg ? platformPackageSpec(pkg) : undefined;
    const artifactKind = "TYPESCRIPT" as const;
    if (declaredSpec === undefined) {
      platformConsumer = {
        schemaVersion: 1,
        sourceSha: snapshot.sourceSha,
        integration: "MISSING",
        evidenceDigest: platformEvidenceDigest({
          contractVersion: "platform-consumer-discovery/v1",
          sourceSha: snapshot.sourceSha,
          artifactKind,
          integration: "MISSING",
          reason: "PACKAGE_NOT_DECLARED",
        }),
      };
    } else {
      const declaredVersion = exactPlatformVersion(declaredSpec);
      const lockPath = packageLockPath(candidate.workingDirectory, packageManager.value, pathSet);
      // floating dependency는 exact SDK 증거가 될 수 없으므로 lockfile을 읽지 않는다.
      // 큰 lockfile 때문에 제품/target 탐지 전체가 막히지 않게 fail-closed 결과만 남긴다.
      if (declaredVersion && lockPath) {
        const lockReadError = await readPaths([lockPath], REPOSITORY_DISCOVERY_MAX_LOCKFILE_BYTES);
        if (lockReadError) return needsInput(snapshot, lockReadError, candidates, sourceMetadata);
      }
      const lock = declaredVersion && lockPath
        ? packageManager.value === "pnpm"
          ? parsePnpmPlatformLock(texts.get(lockPath)!, lockPath, candidate.workingDirectory)
          : parseNpmPlatformLock(texts.get(lockPath)!, lockPath, candidate.workingDirectory)
        : null;
      if (declaredVersion && lock?.version === declaredVersion) {
        const evidenceDigest = platformEvidenceDigest({
          contractVersion: "platform-consumer-discovery/v1",
          sourceSha: snapshot.sourceSha,
          artifactKind,
          integration: "SDK",
          packageName: "@seorilabs/platform-sdk",
          declaredVersion,
          lockPath,
          lockVersion: lock.version,
          lockIntegrity: lock.integrity,
        });
        platformConsumer = {
          schemaVersion: 1,
          sourceSha: snapshot.sourceSha,
          integration: "SDK",
          artifactKind,
          observedVersion: declaredVersion,
          observedDigest: null,
          contractRevision: null,
          evidenceDigest,
          lockIntegrity: lock.integrity,
        };
      } else {
        platformConsumer = {
          schemaVersion: 1,
          sourceSha: snapshot.sourceSha,
          integration: "CUSTOM_HTTP",
          evidenceDigest: platformEvidenceDigest({
            contractVersion: "platform-consumer-discovery/v1",
            sourceSha: snapshot.sourceSha,
            artifactKind,
            integration: "CUSTOM_HTTP",
            reason: declaredVersion ? "LOCK_NOT_EXACT" : "DEPENDENCY_NOT_EXACT",
            lockPath,
          }),
        };
      }
    }
  } else {
    workflowCaller = {
      profile: "godot",
      packageManager: null,
      workingDirectory: candidate.workingDirectory,
    };
    const artifactKind = "GDSCRIPT" as const;
    const addonDirectories = [
      pathIn(candidate.workingDirectory, "addons/seorilabs_platform"),
      pathIn(candidate.workingDirectory, "game/addons/seorilabs_platform"),
    ].filter((directory, index, values) => (
      values.indexOf(directory) === index
      && (
        snapshot.paths.some((path) => path.startsWith(`${directory}/`))
        || (snapshot.gitlinkPaths ?? []).some((path) => path === directory || path.startsWith(`${directory}/`))
      )
    ));
    const addonDirectory = addonDirectories[0]
      ?? pathIn(candidate.workingDirectory, "addons/seorilabs_platform");
    const addonPrefix = `${addonDirectory}/`;
    const addonPaths = snapshot.paths
      .filter((path) => path.startsWith(addonPrefix))
      .sort((left, right) => left.localeCompare(right));
    const addonGitlinkPaths = (snapshot.gitlinkPaths ?? [])
      .filter((path) => path === addonDirectory || path.startsWith(addonPrefix))
      .sort((left, right) => left.localeCompare(right));
    if (addonDirectories.length > 1) {
      platformConsumer = {
        schemaVersion: 1,
        sourceSha: snapshot.sourceSha,
        integration: "CUSTOM_HTTP",
        evidenceDigest: platformEvidenceDigest({
          contractVersion: "platform-consumer-discovery/v1",
          sourceSha: snapshot.sourceSha,
          artifactKind,
          integration: "CUSTOM_HTTP",
          reason: "MULTIPLE_ADDON_ROOTS",
        }),
      };
    } else if (addonGitlinkPaths.length > 0) {
      platformConsumer = {
        schemaVersion: 1,
        sourceSha: snapshot.sourceSha,
        integration: "CUSTOM_HTTP",
        evidenceDigest: platformEvidenceDigest({
          contractVersion: "platform-consumer-discovery/v1",
          sourceSha: snapshot.sourceSha,
          artifactKind,
          integration: "CUSTOM_HTTP",
          reason: "ADDON_GITLINK_PRESENT",
          gitlinkCount: addonGitlinkPaths.length,
        }),
      };
    } else if (addonPaths.length === 0) {
      platformConsumer = {
        schemaVersion: 1,
        sourceSha: snapshot.sourceSha,
        integration: "MISSING",
        evidenceDigest: platformEvidenceDigest({
          contractVersion: "platform-consumer-discovery/v1",
          sourceSha: snapshot.sourceSha,
          artifactKind,
          integration: "MISSING",
          reason: "ADDON_NOT_PRESENT",
        }),
      };
    } else {
      const addonReadError = await readPaths(addonPaths);
      if (addonReadError) return needsInput(snapshot, addonReadError, candidates, sourceMetadata);
      const sourcePath = `${addonDirectory}/SOURCE`;
      const versionPath = `${addonDirectory}/VERSION`;
      const checksumPath = `${addonDirectory}/CHECKSUM`;
      const source = texts.get(sourcePath)?.trim() ?? "";
      const version = texts.get(versionPath)?.trim() ?? "";
      const declaredChecksum = texts.get(checksumPath)?.trim().toLowerCase() ?? "";
      const treeChecksum = vendoredTreeChecksum(addonPaths
        .filter((path) => path !== checksumPath)
        .map((path) => ({ path: path.slice(addonPrefix.length), text: texts.get(path)! })));
      const expectedSource = /^\d+\.\d+\.\d+$/.test(version)
        ? `https://github.com/seorilabs/platform/releases/download/v${version}/seorilabs-platform-gdscript-${version}.tar.gz`
        : "";
      if (
        source === expectedSource
        && /^[0-9a-f]{64}$/.test(declaredChecksum)
        && declaredChecksum === treeChecksum
      ) {
        const evidenceDigest = platformEvidenceDigest({
          contractVersion: "platform-consumer-discovery/v1",
          sourceSha: snapshot.sourceSha,
          artifactKind,
          integration: "SDK",
          observedVersion: version,
          releaseAssetUrl: source,
          treeChecksum,
          sourceCount: addonPaths.length,
        });
        platformConsumer = {
          schemaVersion: 1,
          sourceSha: snapshot.sourceSha,
          integration: "SDK",
          artifactKind,
          observedVersion: version,
          observedDigest: null,
          contractRevision: null,
          evidenceDigest,
          releaseAssetUrl: source,
          treeChecksum,
        };
      } else {
        platformConsumer = {
          schemaVersion: 1,
          sourceSha: snapshot.sourceSha,
          integration: "CUSTOM_HTTP",
          evidenceDigest: platformEvidenceDigest({
            contractVersion: "platform-consumer-discovery/v1",
            sourceSha: snapshot.sourceSha,
            artifactKind,
            integration: "CUSTOM_HTTP",
            reason: source !== expectedSource ? "FLOATING_OR_INVALID_SOURCE" : "TREE_CHECKSUM_MISMATCH",
            sourceCount: addonPaths.length,
          }),
        };
      }
    }
  }

  const stack = candidate.profile;
  const buildTargets: RepositoryDiscoveryBuildTarget[] = [];
  const buildSourcePaths: string[] = [];
  if (candidate.profile !== "godot") {
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
      buildTargets.push({
        targetKey: "android",
        stack,
        market: "google-play",
        packageId: androidIds[0] ?? null,
        bundleId: null,
        configuration: null,
      });
    }
    if (iosPaths.length > 0) {
      buildTargets.push({
        targetKey: "ios",
        stack,
        market: "app-store",
        packageId: null,
        bundleId: iosIds[0] ?? null,
        configuration: null,
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
    if (hasAndroidTarget) {
      buildTargets.push({
        targetKey: "android",
        stack,
        market: "google-play",
        packageId: androidIds[0] ?? null,
        bundleId: null,
        configuration: null,
      });
    }
    if (hasIosTarget) {
      buildTargets.push({
        targetKey: "ios",
        stack,
        market: "app-store",
        packageId: null,
        bundleId: iosIds[0] ?? null,
        configuration: null,
      });
    }
  }

  const appsInTossTargetPaths = [...granitePaths, ...appsInTossConfigPaths];
  const appsInTossReadError = await readPaths(appsInTossTargetPaths);
  if (appsInTossReadError) return needsInput(snapshot, appsInTossReadError, candidates, sourceMetadata);
  if (appsInTossTargetPaths.length > 0) {
    const appNames = parseGraniteAppNames(appsInTossTargetPaths.map((path) => texts.get(path)!));
    if (appNames.length > 1) {
      return needsInput(snapshot, "BUILD_IDENTITY_AMBIGUOUS", candidates, sourceMetadata);
    }
    buildTargets.push({
      targetKey: "ait",
      stack,
      market: "apps-in-toss",
      packageId: null,
      bundleId: null,
      configuration: appNames[0] ? { appName: appNames[0] } : null,
    });
  }

  if (buildTargets.length === 0) {
    return needsInput(snapshot, "BUILD_TARGET_MISSING", candidates, sourceMetadata);
  }

  return finish(snapshot, {
    status: "ACTIVE" as const,
    managementKind: "APP" as const,
    classification: "PRODUCT_APP" as const,
    reasonCode: null,
    candidates,
    sourceMetadata,
    appType: candidate.profile === "godot" ? "GAME" as const : "APP" as const,
    engine: candidate.profile === "godot" ? "GODOT" as const : "RN" as const,
    workflowCaller,
    buildTargets: buildTargets.sort((left, right) => left.targetKey.localeCompare(right.targetKey)),
    platformConsumer,
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
