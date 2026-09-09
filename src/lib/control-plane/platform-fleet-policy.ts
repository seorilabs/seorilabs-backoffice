import type {
  PlatformConsumerObservationPayload,
  PlatformReleaseManifest,
} from "@/lib/control-plane/contracts";

/**
 * disposition 판정 규칙의 개정판.
 *
 * reconcile 멱등 키가 `{platformReleaseId, consumers}`뿐이면 이미 판정된 조합은 결과를
 * 영원히 replay하므로 정책을 바꿔도 기존 소비자에는 적용되지 않는다. 실제로 이 개정을
 * 만든 ahead 소비자가 옛 SDK_UPDATE_PR 계획에 그대로 남는다.
 *
 * 판정 의미를 바꿀 때마다 올린다. 그러면 다음 producer 실행이 한 번 다시 판정한다.
 */
export const platformFleetPolicyRevision = "platform-fleet-policy-v2-ahead-unmanaged";

export type PlatformFleetDisposition = {
  kind:
    | "SDK_UPDATE_PR"
    | "CONTRACT_ISSUE"
    | "CUSTOM_UNMANAGED"
    | "MISSING_UNMANAGED"
    | "AHEAD_UNMANAGED"
    | "COMPLIANT";
  status: "QUEUED" | "PENDING" | "UNMANAGED" | "COMPLIANT";
  bindingState: string;
};

/**
 * 저장소가 승인본보다 앞선 SDK를 쓰는지 본다.
 *
 * 미발행 draft 릴리스를 벤더링하면 이 상태가 된다. 실제로 두 번 일어났고
 * (lizard-tycoon이 draft 0.7.4, lord-ledger가 draft 0.7.8), 그때마다 fleet 준수가
 * 깨진 채 P7 readiness에서야 드러났다.
 *
 * 버전 비교만으로 판정한다. draft 여부는 관측에 없고, 승인본보다 앞선 상태는 그 자체로
 * 조치가 필요하다 — 릴리스를 발행하거나 저장소를 승인본으로 되돌려야 한다.
 */
function aheadOfApproved(observed: string | null | undefined, approved: string): boolean {
  const parse = (value: string) => {
    const parts = value.split(".");
    if (parts.length !== 3) return null;
    const numbers = parts.map((part) => (/^\d{1,9}$/u.test(part) ? Number(part) : Number.NaN));
    return numbers.some((part) => !Number.isInteger(part)) ? null : numbers;
  };
  const left = typeof observed === "string" ? parse(observed) : null;
  const right = parse(approved);
  if (left === null || right === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return false;
}

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
  // 승인본보다 앞선 저장소에 SDK_UPDATE_PR을 걸면 "더 낮은 버전으로 갱신"을 지시하게 된다.
  // 실제로 필요한 조치는 릴리스 발행이거나 저장소 되돌리기이므로 사람이 볼 remediation으로 뺀다.
  if (aheadOfApproved(input.observation.observedVersion, input.artifact.version)) {
    return {
      kind: "AHEAD_UNMANAGED",
      status: "PENDING",
      bindingState: "AHEAD_UNMANAGED_REMEDIATION_PENDING",
    };
  }
  return { kind: "SDK_UPDATE_PR", status: "QUEUED", bindingState: "UPDATE_PR_QUEUED" };
}
