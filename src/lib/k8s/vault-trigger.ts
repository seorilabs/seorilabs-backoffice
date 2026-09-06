import { randomUUID } from "node:crypto";
import { k8sApi } from "@/lib/k8s/in-cluster";

export const VAULT_INDEX_REQUEST_PATH = "/api/v1/namespaces/data/configmaps/vault-index-request";

export interface TriggerResult {
  triggered: boolean;
  name: string;
  message: string;
}

/** 고정 요청 한 건만 기록한다. 실행 image·명령·볼륨·환경변수는 요청으로 받지 않는다. */
export async function triggerVaultIndex(request = k8sApi): Promise<TriggerResult> {
  const requestId = randomUUID();
  const result = await request("PATCH", VAULT_INDEX_REQUEST_PATH, { data: { requestId } });
  if (result.status !== 200) throw new Error(`볼트 인덱싱 요청 저장 실패 (status ${result.status})`);
  return { triggered: true, name: requestId, message: "재인덱싱을 요청했습니다. 고정 실행기가 순서대로 처리합니다." };
}
