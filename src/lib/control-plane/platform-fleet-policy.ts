import type {
  PlatformConsumerObservationPayload,
  PlatformReleaseManifest,
} from "@/lib/control-plane/contracts";

export type PlatformFleetDisposition = {
  kind: "SDK_UPDATE_PR" | "CONTRACT_ISSUE" | "CUSTOM_UNMANAGED" | "MISSING_UNMANAGED" | "COMPLIANT";
  status: "QUEUED" | "PENDING" | "UNMANAGED" | "COMPLIANT";
  bindingState: string;
};

export function platformFleetDisposition(input: {
  classification: PlatformReleaseManifest["classification"];
  contractRevision: string;
  artifact: PlatformReleaseManifest["artifacts"][number];
  observation: PlatformConsumerObservationPayload;
}): PlatformFleetDisposition {
  // 계약 추가/변경은 현재 SDK byte나 integration 상태보다 먼저 사람이 검토할
  // repo별 적응 작업을 만든다. 그렇지 않으면 같은 package byte를 쓰는 consumer는
  // COMPLIANT로, custom/missing consumer는 remediation으로 빠져 계약 fan-out에서
  // 누락된다.
  if (input.classification !== "IMPLEMENTATION_ONLY") {
    return { kind: "CONTRACT_ISSUE", status: "PENDING", bindingState: "CONTRACT_ISSUE_PENDING" };
  }
  if (input.observation.integration === "CUSTOM_HTTP") {
    return {
      kind: "CUSTOM_UNMANAGED",
      status: "PENDING",
      bindingState: "CUSTOM_UNMANAGED_REMEDIATION_PENDING",
    };
  }
  if (input.observation.integration === "MISSING") {
    return {
      kind: "MISSING_UNMANAGED",
      status: "PENDING",
      bindingState: "MISSING_UNMANAGED_REMEDIATION_PENDING",
    };
  }
  const current = input.observation.artifactKind === input.artifact.kind
    && input.observation.observedVersion === input.artifact.version
    && input.observation.observedDigest?.toLowerCase() === input.artifact.digest.toLowerCase()
    && input.observation.contractRevision?.toLowerCase() === input.contractRevision.toLowerCase()
    && (
      input.artifact.kind !== "GDSCRIPT"
      || (
        input.observation.treeChecksum?.toLowerCase() === input.artifact.treeChecksum.toLowerCase()
        && input.observation.releaseAssetUrl === input.artifact.releaseAssetUrl
      )
    );
  if (current) return { kind: "COMPLIANT", status: "COMPLIANT", bindingState: "COMPLIANT" };
  return { kind: "SDK_UPDATE_PR", status: "QUEUED", bindingState: "UPDATE_PR_QUEUED" };
}
