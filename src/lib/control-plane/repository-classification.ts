export type RepositoryClassification =
  | "PRODUCT_APP"
  | "INFRA_REPO"
  | "PLATFORM_PRODUCER"
  | "EXCLUDED";

export interface RepositoryProductIdentity {
  displayName: string;
  type: "APP" | "GAME";
  engine: "RN" | "GODOT";
}

export interface RepositoryClassificationDirective {
  revision: number;
  classification: RepositoryClassification;
  candidateMarkerPath: string | null;
  productIdentity: RepositoryProductIdentity | null;
}

export interface RepositoryClassificationPolicy {
  classification: Exclude<RepositoryClassification, "PRODUCT_APP"> | "PRODUCT_APP_CANDIDATE";
  reasonCode: "INFRASTRUCTURE_REPOSITORY" | "NON_PRODUCT_REPOSITORY" | "PLATFORM_SDK_PRODUCER" | null;
  allowPublicDiscovery: boolean;
}

/**
 * 모바일 제품이 아닌 조직 저장소의 중앙 분류 계약이다. 앱 저장소마다 선언 파일을
 * 요구하지 않으며, 이 목록 밖에서 RN/Capacitor/AIT web/Godot 제품 근거가 없으면 추측하지 않고
 * NO_CANDIDATE로 남긴다.
 */
const EXACT_POLICIES = new Map<string, RepositoryClassificationPolicy>([
  ["seorilabs/.github", {
    classification: "INFRA_REPO",
    reasonCode: "INFRASTRUCTURE_REPOSITORY",
    allowPublicDiscovery: true,
  }],
  ["seorilabs/credentials", {
    classification: "INFRA_REPO",
    reasonCode: "INFRASTRUCTURE_REPOSITORY",
    allowPublicDiscovery: false,
  }],
  ["seorilabs/gemini-pr-bot", {
    classification: "INFRA_REPO",
    reasonCode: "INFRASTRUCTURE_REPOSITORY",
    allowPublicDiscovery: false,
  }],
  ["seorilabs/seori-pr-bot", {
    classification: "INFRA_REPO",
    reasonCode: "INFRASTRUCTURE_REPOSITORY",
    allowPublicDiscovery: false,
  }],
  ["seorilabs/presentations", {
    classification: "INFRA_REPO",
    reasonCode: "INFRASTRUCTURE_REPOSITORY",
    allowPublicDiscovery: false,
  }],
  ["seorilabs/seorilabs-backoffice", {
    classification: "INFRA_REPO",
    reasonCode: "INFRASTRUCTURE_REPOSITORY",
    allowPublicDiscovery: false,
  }],
  ["seorilabs/planning", {
    classification: "EXCLUDED",
    reasonCode: "NON_PRODUCT_REPOSITORY",
    allowPublicDiscovery: false,
  }],
  ["seorilabs/seorilabs-official", {
    classification: "EXCLUDED",
    reasonCode: "NON_PRODUCT_REPOSITORY",
    allowPublicDiscovery: true,
  }],
  ["seorilabs/platform", {
    classification: "PLATFORM_PRODUCER",
    reasonCode: "PLATFORM_SDK_PRODUCER",
    allowPublicDiscovery: true,
  }],
  // 공개 모바일 제품은 source discovery만 허용한다. public PR의 ARC 실행 허용과는 무관하다.
  ["seorilabs/periodic-table-app", {
    classification: "PRODUCT_APP_CANDIDATE",
    reasonCode: null,
    allowPublicDiscovery: true,
  }],
  ["seorilabs/trait-test-hub", {
    classification: "PRODUCT_APP_CANDIDATE",
    reasonCode: null,
    allowPublicDiscovery: true,
  }],
]);

export function repositoryClassificationPolicy(
  fullName: string,
): RepositoryClassificationPolicy | null {
  const normalized = fullName.toLowerCase();
  const exact = EXACT_POLICIES.get(normalized);
  if (exact) return exact;
  const name = normalized.split("/").at(-1) ?? "";
  if (name === "archive" || name.startsWith("starter-template-")) {
    return {
      classification: "EXCLUDED",
      reasonCode: "NON_PRODUCT_REPOSITORY",
      allowPublicDiscovery: false,
    };
  }
  return null;
}

export function repositoryPublicDiscoveryAllowed(fullName: string): boolean {
  return repositoryClassificationPolicy(fullName)?.allowPublicDiscovery === true;
}
