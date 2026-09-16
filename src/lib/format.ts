// 시각 표기는 @/lib/format/kst 가 정본이다. 여기에는 시각이 아닌 유틸만 둔다.

export function daysSince(d: Date | null | undefined): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}
