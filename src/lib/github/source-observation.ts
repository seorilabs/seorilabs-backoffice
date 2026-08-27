import { createHash } from "node:crypto";

import type { Octokit } from "@/lib/github/app";

/**
 * Discovery 입력은 작은 텍스트 설정 파일만 읽는다. GitHub Contents API가 반환한
 * size를 믿기 전에 encoded payload 길이도 검사해 비정상 응답의 메모리 사용을 제한한다.
 */
export const SOURCE_OBSERVATION_MAX_BYTES = 256 * 1024;

export type SourceObservationStatus =
  | "PRESENT"
  | "ABSENT"
  | "ACCESS_DENIED"
  | "INVALID_CONTENT"
  | "TOO_LARGE"
  | "IDENTITY_MISMATCH";

export type SourceObservationReason =
  | "PATH_NOT_ALLOWED"
  | "INVALID_REPOSITORY_ID"
  | "INVALID_REPOSITORY_FULL_NAME"
  | "INVALID_SOURCE_SHA"
  | "REPOSITORY_UNAVAILABLE"
  | "REPOSITORY_ACCESS_DENIED"
  | "REPOSITORY_ID_MISMATCH"
  | "REPOSITORY_FULL_NAME_MISMATCH"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_ACCESS_DENIED"
  | "SOURCE_SHA_MISMATCH"
  | "PATH_NOT_FOUND"
  | "PATH_ACCESS_DENIED"
  | "DIRECTORY"
  | "UNSUPPORTED_OBJECT"
  | "INVALID_SIZE"
  | "SIZE_MISMATCH"
  | "MISSING_CONTENT"
  | "INVALID_BLOB_SHA"
  | "INVALID_BASE64"
  | "INVALID_UTF8"
  | "SIZE_LIMIT_EXCEEDED";

export interface SourceObservationInput {
  repoId: number | bigint;
  fullName: string;
  /** 반드시 40자리 commit SHA여야 하며 GitHub read ref로 유일하게 사용된다. */
  sourceSha: string;
  /** 브랜치/태그 provenance 전용. GitHub read ref로 사용하지 않는다. */
  sourceRef?: string | null;
  path: string;
  /** 호출자가 명시적으로 허용한 정확한 repo-relative path 집합. */
  allowedPaths: readonly string[];
}

interface SourceObservationBase {
  status: SourceObservationStatus;
  reason: SourceObservationReason | null;
  repoId: number;
  fullName: string;
  sourceSha: string;
  sourceRef: string | null;
  path: string;
  blobSha: string | null;
  contentSha256: string | null;
  size: number | null;
}

export interface PresentSourceObservation extends SourceObservationBase {
  status: "PRESENT";
  reason: null;
  blobSha: string;
  contentSha256: string;
  size: number;
  /** transient parser input. toSourceMetadata()는 이 값을 구조적으로 제거한다. */
  text: string;
}

export interface NonPresentSourceObservation extends SourceObservationBase {
  status: Exclude<SourceObservationStatus, "PRESENT">;
  reason: SourceObservationReason;
  text?: never;
}

export type SourceObservationResult =
  | PresentSourceObservation
  | NonPresentSourceObservation;

/** DB JSON에 저장 가능한 비민감 provenance. 원문 content/text는 포함할 수 없다. */
export interface SourcePersistenceMetadata {
  status: SourceObservationStatus;
  reason: SourceObservationReason | null;
  repoId: number;
  fullName: string;
  sourceSha: string;
  sourceRef: string | null;
  path: string;
  blobSha: string | null;
  contentSha256: string | null;
  size: number | null;
}

export type SourceObservationOctokit = {
  rest: {
    repos: Pick<Octokit["rest"]["repos"], "get" | "getCommit" | "getContent">;
  };
};

type ReadStage = "repository" | "source" | "path";

export class SourceObservationReadError extends Error {
  readonly stage: ReadStage;
  readonly httpStatus: number | null;

  constructor(stage: ReadStage, httpStatus: number | null) {
    super(`GitHub source observation read failed at ${stage}`);
    this.name = "SourceObservationReadError";
    this.stage = stage;
    this.httpStatus = httpStatus;
  }
}

const SHA_40 = /^[0-9a-f]{40}$/i;
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function normalizeRepoId(repoId: number | bigint): number | null {
  if (typeof repoId === "bigint") {
    if (repoId <= 0n || repoId > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(repoId);
  }
  return Number.isSafeInteger(repoId) && repoId > 0 ? repoId : null;
}

function splitFullName(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split("/");
  if (
    parts.length !== 2
    || !REPO_SEGMENT.test(parts[0])
    || !REPO_SEGMENT.test(parts[1])
  ) {
    return null;
  }
  return { owner: parts[0], repo: parts[1] };
}

function base(
  input: SourceObservationInput,
  repoId: number,
  sourceSha: string,
): Omit<SourceObservationBase, "status" | "reason"> {
  return {
    repoId,
    fullName: input.fullName,
    sourceSha,
    sourceRef: input.sourceRef ?? null,
    path: input.path,
    blobSha: null,
    contentSha256: null,
    size: null,
  };
}

function nonPresent(
  common: Omit<SourceObservationBase, "status" | "reason">,
  status: NonPresentSourceObservation["status"],
  reason: SourceObservationReason,
  fields: Partial<Pick<SourceObservationBase, "blobSha" | "contentSha256" | "size">> = {},
): NonPresentSourceObservation {
  return { ...common, ...fields, status, reason };
}

function httpStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function mapHttpError(
  error: unknown,
  stage: ReadStage,
  common: Omit<SourceObservationBase, "status" | "reason">,
): NonPresentSourceObservation {
  const status = httpStatus(error);
  if (status === 404) {
    // 등록된 numeric repository identity의 name lookup 404는 GitHub App 권한
    // 은닉과 실제 삭제를 구분할 수 없으므로 파일 부재로 단정하지 않는다.
    if (stage === "repository") {
      return nonPresent(common, "ACCESS_DENIED", "REPOSITORY_UNAVAILABLE");
    }
    if (stage === "source") {
      return nonPresent(common, "IDENTITY_MISMATCH", "SOURCE_NOT_FOUND");
    }
    return nonPresent(common, "ABSENT", "PATH_NOT_FOUND");
  }
  if (status === 401 || status === 403) {
    const reason = stage === "repository"
      ? "REPOSITORY_ACCESS_DENIED"
      : stage === "source"
        ? "SOURCE_ACCESS_DENIED"
        : "PATH_ACCESS_DENIED";
    return nonPresent(common, "ACCESS_DENIED", reason);
  }
  throw new SourceObservationReadError(stage, status);
}

function decodeBase64Strict(content: string): Buffer | null {
  const compact = content.replace(/[\t\n\r ]/g, "");
  if (compact.length === 0) return Buffer.alloc(0);
  if (
    compact.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
  ) {
    return null;
  }
  const decoded = Buffer.from(compact, "base64");
  return decoded.toString("base64") === compact ? decoded : null;
}

/**
 * 숫자 repo identity를 먼저 검증한 뒤 정확한 commit SHA에서 allowlist path 하나만 읽는다.
 * sourceRef는 결과 provenance로만 보존하며 어떤 GitHub 요청에도 ref로 사용하지 않는다.
 */
export async function readExactSourceFile(
  octokit: SourceObservationOctokit,
  input: SourceObservationInput,
): Promise<SourceObservationResult> {
  const normalizedRepoId = normalizeRepoId(input.repoId);
  const normalizedSha = input.sourceSha.toLowerCase();
  const placeholderRepoId = normalizedRepoId ?? 0;
  const common = base(input, placeholderRepoId, normalizedSha);

  if (!input.allowedPaths.includes(input.path)) {
    return nonPresent(common, "ACCESS_DENIED", "PATH_NOT_ALLOWED");
  }
  if (normalizedRepoId === null) {
    return nonPresent(common, "IDENTITY_MISMATCH", "INVALID_REPOSITORY_ID");
  }
  if (!splitFullName(input.fullName)) {
    return nonPresent(common, "IDENTITY_MISMATCH", "INVALID_REPOSITORY_FULL_NAME");
  }
  if (!SHA_40.test(input.sourceSha)) {
    return nonPresent(common, "IDENTITY_MISMATCH", "INVALID_SOURCE_SHA");
  }

  const identity = splitFullName(input.fullName)!;
  let repositoryData: unknown;
  try {
    repositoryData = (await octokit.rest.repos.get(identity)).data;
  } catch (error) {
    return mapHttpError(error, "repository", common);
  }
  const repository = repositoryData as { id?: unknown; full_name?: unknown };
  if (repository.id !== normalizedRepoId) {
    return nonPresent(common, "IDENTITY_MISMATCH", "REPOSITORY_ID_MISMATCH");
  }
  if (
    typeof repository.full_name !== "string"
    || repository.full_name.toLowerCase() !== input.fullName.toLowerCase()
  ) {
    return nonPresent(common, "IDENTITY_MISMATCH", "REPOSITORY_FULL_NAME_MISMATCH");
  }

  let commitData: unknown;
  try {
    commitData = (await octokit.rest.repos.getCommit({
      ...identity,
      ref: normalizedSha,
    })).data;
  } catch (error) {
    return mapHttpError(error, "source", common);
  }
  const commitSha = (commitData as { sha?: unknown }).sha;
  if (typeof commitSha !== "string" || commitSha.toLowerCase() !== normalizedSha) {
    return nonPresent(common, "IDENTITY_MISMATCH", "SOURCE_SHA_MISMATCH");
  }

  let contentData: unknown;
  try {
    contentData = (await octokit.rest.repos.getContent({
      ...identity,
      path: input.path,
      ref: normalizedSha,
    })).data;
  } catch (error) {
    return mapHttpError(error, "path", common);
  }

  if (Array.isArray(contentData)) {
    return nonPresent(common, "INVALID_CONTENT", "DIRECTORY");
  }
  if (!contentData || typeof contentData !== "object") {
    return nonPresent(common, "INVALID_CONTENT", "UNSUPPORTED_OBJECT");
  }

  const file = contentData as {
    type?: unknown;
    content?: unknown;
    encoding?: unknown;
    sha?: unknown;
    size?: unknown;
  };
  if (file.type === "dir") {
    return nonPresent(common, "INVALID_CONTENT", "DIRECTORY");
  }
  if (file.type !== "file") {
    return nonPresent(common, "INVALID_CONTENT", "UNSUPPORTED_OBJECT");
  }
  if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) {
    return nonPresent(common, "INVALID_CONTENT", "INVALID_SIZE");
  }

  const declaredSize = file.size as number;
  if (declaredSize > SOURCE_OBSERVATION_MAX_BYTES) {
    return nonPresent(common, "TOO_LARGE", "SIZE_LIMIT_EXCEEDED", {
      size: declaredSize,
    });
  }
  if (typeof file.sha !== "string" || !SHA_40.test(file.sha)) {
    return nonPresent(common, "INVALID_CONTENT", "INVALID_BLOB_SHA", {
      size: declaredSize,
    });
  }
  const blobSha = file.sha.toLowerCase();
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    return nonPresent(common, "INVALID_CONTENT", "MISSING_CONTENT", {
      blobSha,
      size: declaredSize,
    });
  }

  const compactBase64Length = file.content.replace(/[\t\n\r ]/g, "").length;
  const maximumEncodedLength = 4 * Math.ceil(SOURCE_OBSERVATION_MAX_BYTES / 3);
  if (compactBase64Length > maximumEncodedLength) {
    return nonPresent(common, "TOO_LARGE", "SIZE_LIMIT_EXCEEDED", {
      blobSha,
      size: declaredSize,
    });
  }

  const bytes = decodeBase64Strict(file.content);
  if (!bytes) {
    return nonPresent(common, "INVALID_CONTENT", "INVALID_BASE64", {
      blobSha,
      size: declaredSize,
    });
  }
  if (bytes.byteLength > SOURCE_OBSERVATION_MAX_BYTES) {
    return nonPresent(common, "TOO_LARGE", "SIZE_LIMIT_EXCEEDED", {
      blobSha,
      size: bytes.byteLength,
    });
  }
  if (bytes.byteLength !== declaredSize) {
    return nonPresent(common, "INVALID_CONTENT", "SIZE_MISMATCH", {
      blobSha,
      size: declaredSize,
    });
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return nonPresent(common, "INVALID_CONTENT", "INVALID_UTF8", {
      blobSha,
      size: declaredSize,
    });
  }

  return {
    ...common,
    status: "PRESENT",
    reason: null,
    blobSha,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    text,
  };
}

/** 원문을 명시적으로 탈락시킨 뒤에만 observation payload로 보낸다. */
export function toSourceMetadata(result: SourceObservationResult): SourcePersistenceMetadata {
  return {
    status: result.status,
    reason: result.reason,
    repoId: result.repoId,
    fullName: result.fullName,
    sourceSha: result.sourceSha,
    sourceRef: result.sourceRef,
    path: result.path,
    blobSha: result.blobSha,
    contentSha256: result.contentSha256,
    size: result.size,
  };
}
