import type { SourceObservationOctokit } from "@/lib/github/source-observation";
import { readExactSourceFile, SOURCE_OBSERVATION_ABSOLUTE_MAX_BYTES } from "@/lib/github/source-observation";

export interface DependencyAuditLockfileInput {
  repositoryId: string;
  fullName: string;
  sourceSha: string;
  dependencyRoot: string;
  packageManager: "npm" | "pnpm" | null;
}

export type DependencyAuditLockfileReader = (input: DependencyAuditLockfileInput) => Promise<string | null>;

/** 실행에 쓰는 dependency root의 실제 bytes를 exact source와 숫자 repository identity로 확인한다. */
export async function readDependencyAuditLockfile(
  input: DependencyAuditLockfileInput,
  client?: SourceObservationOctokit,
): Promise<string | null> {
  if (!input.packageManager || !/^[0-9]+$/u.test(input.repositoryId)) return null;
  const root = input.dependencyRoot;
  if (root !== "." && !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(root)) return null;
  if (root !== "." && root.split("/").some((part) => part === "." || part === "..")) return null;
  const lockName = input.packageManager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
  const path = root === "." ? lockName : `${root}/${lockName}`;
  const octokit = client ?? await (await import("@/lib/github/app")).getInstallationOctokit();
  const observation = await readExactSourceFile(octokit, {
    repoId: BigInt(input.repositoryId),
    fullName: input.fullName,
    sourceSha: input.sourceSha,
    path,
    allowedPaths: [path],
    maxBytes: SOURCE_OBSERVATION_ABSOLUTE_MAX_BYTES,
  });
  if (observation.status === "PRESENT") return `sha256:${observation.contentSha256}`;
  if (observation.status === "ABSENT") return null;
  throw new Error("DEPENDENCY_AUDIT_LOCKFILE_READ_FAILED");
}
