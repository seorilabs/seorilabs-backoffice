export function dayKey(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}
export function afterNine(now = new Date()): boolean {
  return (now.getUTCHours() + 9) % 24 >= 9;
}
export function eligibility(
  o: {
    observedAt: Date;
    expiresAt: Date;
    waitUntil: Date | null;
    samples: number;
    minSamples: number;
    resolved?: boolean;
  },
  now: Date,
): string | null {
  if (o.resolved) return "resolved";
  if (o.observedAt.getTime() > now.getTime() + 60000) return "future";
  if (o.expiresAt <= now) return "stale";
  if (o.samples < o.minSamples) return "samples";
  if (o.waitUntil && o.waitUntil > now) return "waiting";
  return null;
}
export function canDecide(
  p: {
    version: number;
    digest: string;
    status: string;
    snoozedUntil: Date | null;
  },
  version: number,
  digest: string,
  now: Date,
): boolean {
  return (
    p.version === version &&
    p.digest === digest &&
    (p.status === "READY" ||
      (p.status === "SNOOZED" && !!p.snoozedUntil && p.snoozedUntil <= now))
  );
}
export function canReport(
  r: {
    executionLocation: string | null;
    status: string;
    executionOwner: string | null;
    generation: number | null;
    leaseUntil: Date | null;
  },
  owner: string,
  generation: number,
  now: Date,
): boolean {
  return (
    r.executionLocation === "LOCAL" &&
    r.status === "PROCESSING" &&
    r.executionOwner === owner &&
    r.generation === generation &&
    !!r.leaseUntil &&
    r.leaseUntil > now
  );
}
interface Candidate {
  targetId: string;
  problemKey: string;
  impact: number;
  confidence: number;
  effortMinutes: number;
  deadline: string | null;
}
export function rankCandidates<T extends Candidate>(
  candidates: T[],
  blocked: Set<string>,
  now: Date,
): T[] {
  const score = (c: T) =>
    (c.impact * c.confidence) / Math.sqrt(Math.max(1, c.effortMinutes)) +
    (c.deadline && Date.parse(c.deadline) - now.getTime() < 86400000 ? 1 : 0);
  const seen = new Set(blocked);
  return [...candidates]
    .sort((a, b) => score(b) - score(a))
    .filter((c) => {
      const key = c.targetId + ":" + c.problemKey;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}
