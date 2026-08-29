export type RepositoryProductPlanningReason =
  | "PRODUCT_SOURCE_CANDIDATE_MISSING"
  | "PRODUCT_BUILD_TARGET_MISSING"
  | "PRODUCT_DISCOVERY_NOT_READY";

/** Explicit PRODUCT_APP purpose와 source/build readiness를 섞지 않는 공통 fail-closed 이유다. */
export function repositoryProductPlanningReason(
  lastDiscoveryReason: string | null,
): RepositoryProductPlanningReason {
  if (lastDiscoveryReason === "NO_CANDIDATE") return "PRODUCT_SOURCE_CANDIDATE_MISSING";
  if (lastDiscoveryReason === "BUILD_TARGET_MISSING") return "PRODUCT_BUILD_TARGET_MISSING";
  return "PRODUCT_DISCOVERY_NOT_READY";
}
