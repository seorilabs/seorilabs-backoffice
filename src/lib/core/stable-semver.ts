export type Bump = "major" | "minor" | "patch";

const STABLE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableSemVerTag(raw: string): [number, number, number] | null {
  const value = raw.replace(/^v/i, "").trim();
  const match = value.match(STABLE_SEMVER_RE);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function normalizeStableSemVerTag(raw: string): string {
  const parts = parseStableSemVerTag(raw);
  if (!parts) throw new Error(`SemVer(vX.Y.Z) 형식이 아닙니다: ${raw}`);
  return `v${parts.join(".")}`;
}

/** 오름차순 비교: a < b 이면 음수, 같으면 0, a > b 이면 양수. */
export function compareStableSemVerTags(a: string, b: string): number {
  const left = parseStableSemVerTag(a);
  const right = parseStableSemVerTag(b);
  if (!left || !right) throw new Error("stable SemVer 태그만 비교할 수 있습니다.");
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function compareStableSemVerTagsDesc(a: string, b: string): number {
  return -compareStableSemVerTags(a, b);
}

export function stableVersionTags<T extends { name: string }>(tags: T[]): T[] {
  return tags
    .filter((tag) => parseStableSemVerTag(tag.name) !== null)
    .sort((a, b) => compareStableSemVerTagsDesc(a.name, b.name));
}

export function bumpStableSemVerTag(latest: string | null, bump: Bump): string {
  const [major, minor, patch] = parseStableSemVerTag(latest ?? "v0.0.0") ?? [];
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined
  ) {
    throw new Error(`SemVer(vX.Y.Z) 형식이 아닙니다: ${latest}`);
  }
  if (bump === "major") return `v${major + 1}.0.0`;
  if (bump === "minor") return `v${major}.${minor + 1}.0`;
  return `v${major}.${minor}.${patch + 1}`;
}
