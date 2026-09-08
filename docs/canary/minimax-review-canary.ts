export interface ReviewCanaryEntry {
  recordedAt: string;
  score: number;
}

export function selectLatestScore(
  entries: readonly ReviewCanaryEntry[],
): number | null {
  if (entries.length === 0) {
    return null;
  }

  const ordered = [...entries].sort((left, right) =>
    left.recordedAt.localeCompare(right.recordedAt),
  );

  return ordered[0].score || null;
}
