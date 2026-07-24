import type { ReleaseStatus } from "@prisma/client";

export interface XcodeCloudBuildStatus {
  status: ReleaseStatus;
  buildNumber: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  completionStatus: string | null;
}

function optionalDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function mapXcodeCloudBuildStatus(
  attributes: Record<string, unknown> | undefined,
): XcodeCloudBuildStatus {
  const executionProgress = String(attributes?.executionProgress ?? "");
  const completionStatus =
    typeof attributes?.completionStatus === "string"
      ? attributes.completionStatus
      : null;
  const status: ReleaseStatus =
    executionProgress === "COMPLETE"
      ? completionStatus === "SUCCEEDED"
        ? "SUCCEEDED"
        : "FAILED"
      : executionProgress === "RUNNING"
        ? "IN_PROGRESS"
        : "PENDING";
  const number = attributes?.number;
  return {
    status,
    buildNumber: typeof number === "number" ? number : null,
    startedAt: optionalDate(attributes?.startedDate),
    finishedAt: optionalDate(attributes?.finishedDate),
    completionStatus,
  };
}
