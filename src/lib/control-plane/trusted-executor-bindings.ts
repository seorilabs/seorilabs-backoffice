/**
 * 신뢰 실행기(파드)마다 attestation route, adapter env, 배포 gate가 한 벌씩 필요하다.
 * 이 값을 security와 attestation 양쪽에 나눠 적으면 실행기를 하나 더 붙일 때 한쪽만
 * 바뀌어 조용히 어긋난다. 실행기별 공개 identity는 여기에서만 선언하고 나머지는 읽는다.
 */
export const TRUSTED_EXECUTOR_GATES = [
  "generic",
  "workflow-bundle-candidate",
  "approved-caller-reconciliation",
] as const;

export type TrustedExecutorGate = typeof TRUSTED_EXECUTOR_GATES[number];

export interface TrustedExecutorAdapterEnvNames {
  /** "true"일 때만 adapter가 존재한다고 본다. */
  deployed: string;
  principal: string;
  runtimeIdentity: string;
  token: string;
  publicKey: string;
}

export interface TrustedExecutorBinding {
  gate: TrustedExecutorGate;
  /** null이면 attestation route가 prefix(agent-adapter)로만 결정된다. */
  attestationRoute: string | null;
  env: TrustedExecutorAdapterEnvNames;
  /** 실행기 파드가 고정으로 제시해야 하는 공개 identity다. generic은 고정하지 않는다. */
  expected: { adapterPrincipal: string; adapterRuntimeIdentity: string } | null;
}

const GENERIC: TrustedExecutorBinding = {
  gate: "generic",
  attestationRoute: null,
  env: {
    deployed: "AGENT_TRUSTED_ADAPTER_DEPLOYED",
    principal: "AGENT_TRUSTED_ADAPTER_PRINCIPAL",
    runtimeIdentity: "AGENT_TRUSTED_ADAPTER_RUNTIME_IDENTITY",
    token: "AGENT_TRUSTED_ADAPTER_TOKEN",
    publicKey: "AGENT_TRUSTED_ADAPTER_PUBLIC_KEY",
  },
  expected: null,
};

export const WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL =
  "seori-auth:workflow-bundle-candidate-adapter" as const;
export const WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY =
  "spiffe://seorilabs.local/ns/auth-broker/sa/workflow-bundle-candidate-executor" as const;
export const APPROVED_CALLER_RECONCILIATION_ADAPTER_PRINCIPAL =
  "seori-auth:approved-caller-reconciliation-adapter" as const;
export const APPROVED_CALLER_RECONCILIATION_ADAPTER_RUNTIME_IDENTITY =
  "spiffe://seorilabs.local/ns/auth-broker/sa/approved-caller-reconciliation-executor" as const;

const WORKFLOW_BUNDLE_CANDIDATE: TrustedExecutorBinding = {
  gate: "workflow-bundle-candidate",
  attestationRoute: "/api/internal/workflow-bundle-candidate-executor",
  env: {
    deployed: "WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_DEPLOYED",
    principal: "WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL",
    runtimeIdentity: "WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY",
    token: "WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_TOKEN",
    publicKey: "WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PUBLIC_KEY",
  },
  expected: {
    adapterPrincipal: WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL,
    adapterRuntimeIdentity: WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY,
  },
};

const APPROVED_CALLER_RECONCILIATION: TrustedExecutorBinding = {
  gate: "approved-caller-reconciliation",
  attestationRoute: "/api/internal/approved-caller-reconciliation-executor",
  env: {
    deployed: "APPROVED_CALLER_RECONCILIATION_EXECUTOR_DEPLOYED",
    principal: "APPROVED_CALLER_RECONCILIATION_ADAPTER_PRINCIPAL",
    runtimeIdentity: "APPROVED_CALLER_RECONCILIATION_ADAPTER_RUNTIME_IDENTITY",
    token: "APPROVED_CALLER_RECONCILIATION_ADAPTER_TOKEN",
    publicKey: "APPROVED_CALLER_RECONCILIATION_ADAPTER_PUBLIC_KEY",
  },
  expected: {
    adapterPrincipal: APPROVED_CALLER_RECONCILIATION_ADAPTER_PRINCIPAL,
    adapterRuntimeIdentity: APPROVED_CALLER_RECONCILIATION_ADAPTER_RUNTIME_IDENTITY,
  },
};

export const TRUSTED_EXECUTOR_BINDINGS: Readonly<Record<TrustedExecutorGate, TrustedExecutorBinding>> =
  Object.freeze({
    generic: Object.freeze(GENERIC),
    "workflow-bundle-candidate": Object.freeze(WORKFLOW_BUNDLE_CANDIDATE),
    "approved-caller-reconciliation": Object.freeze(APPROVED_CALLER_RECONCILIATION),
  });

export const WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_ATTESTATION_ROUTE =
  WORKFLOW_BUNDLE_CANDIDATE.attestationRoute as string;
export const APPROVED_CALLER_RECONCILIATION_EXECUTOR_ATTESTATION_ROUTE =
  APPROVED_CALLER_RECONCILIATION.attestationRoute as string;

export function trustedExecutorAttestationRoutes(): readonly string[] {
  return TRUSTED_EXECUTOR_GATES
    .map((gate) => TRUSTED_EXECUTOR_BINDINGS[gate].attestationRoute)
    .filter((route): route is string => route !== null);
}

/** 자기 gate를 뺀 나머지 실행기의 같은 env 이름들이다. 값 재사용을 fail-closed로 막는다. */
export function peerTrustedExecutorEnvNames(
  gate: TrustedExecutorGate,
  key: keyof TrustedExecutorAdapterEnvNames,
): readonly string[] {
  return TRUSTED_EXECUTOR_GATES
    .filter((candidate) => candidate !== gate)
    .map((candidate) => TRUSTED_EXECUTOR_BINDINGS[candidate].env[key]);
}
