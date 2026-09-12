/**
 * 신뢰 실행기(파드)마다 attestation route, adapter env, 배포 gate가 한 벌씩 필요하다.
 * 이 값을 security와 attestation 양쪽에 나눠 적으면 실행기를 하나 더 붙일 때 한쪽만
 * 바뀌어 조용히 어긋난다. 실행기별 공개 identity는 여기에서만 선언하고 나머지는 읽는다.
 */
export const TRUSTED_EXECUTOR_GATES = ["generic"] as const;

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

export const TRUSTED_EXECUTOR_BINDINGS: Readonly<Record<TrustedExecutorGate, TrustedExecutorBinding>> =
  Object.freeze({ generic: Object.freeze(GENERIC) });
