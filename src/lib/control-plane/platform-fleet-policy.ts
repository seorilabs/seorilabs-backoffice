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
  if (input.observation.integration === "CUSTOM_HTTP") {
    return { kind: "CUSTOM_UNMANAGED", status: "UNMANAGED", bindingState: "CUSTOM_UNMANAGED" };
  }
  if (input.observation.integration === "MISSING") {
    return { kind: "MISSING_UNMANAGED", status: "UNMANAGED", bindingState: "MISSING_UNMANAGED" };
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
  if (input.classification === "IMPLEMENTATION_ONLY") {
    return { kind: "SDK_UPDATE_PR", status: "QUEUED", bindingState: "UPDATE_PR_QUEUED" };
  }
  return { kind: "CONTRACT_ISSUE", status: "PENDING", bindingState: "CONTRACT_ISSUE_PENDING" };
}
