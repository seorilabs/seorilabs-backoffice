import type { LegacyConfigResolutionRequest } from "./contracts";

type Target = LegacyConfigResolutionRequest["dispositions"][number]["targets"][number];

export function nextLegacyResolutionTargets(current: readonly Target[], target: Target): Target[] {
  if (target === "IGNORED_NON_OPERATIONAL") {
    return current.includes(target) ? [] : [target];
  }

  const values = new Set(current.filter((value) => value !== "IGNORED_NON_OPERATIONAL"));
  if (values.has(target)) values.delete(target);
  else values.add(target);
  return [...values].sort();
}
