import type { Priority } from "@prisma/client";

// GitHub 라벨 배열에서 파생 속성 추출 (미러 시 정규화 컬럼으로 저장).

export function normalizeLabels(
  labels: ReadonlyArray<string | { name?: string | null }> | null | undefined,
): string[] {
  if (!labels) return [];
  return labels
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter(Boolean);
}

export function priorityFromLabels(labels: string[]): Priority | null {
  const order: Priority[] = ["P1", "P2", "P3", "P4"];
  for (const p of order) if (labels.includes(p)) return p;
  return null;
}

export const isAutopilot = (labels: string[]): boolean =>
  labels.includes("autopilot");

export const hasEvidence = (labels: string[]): boolean =>
  labels.some((l) => l.startsWith("evidence:"));

export const isBlocked = (labels: string[]): boolean =>
  labels.includes("blocked");

export const hasApproval = (labels: string[], gate: "planning" | "release"): boolean =>
  labels.includes(`approval:${gate}`);
