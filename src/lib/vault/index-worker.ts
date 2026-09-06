import { k8sApi } from "@/lib/k8s/in-cluster";
import { VAULT_INDEX_REQUEST_PATH } from "@/lib/k8s/vault-trigger";

const STATE_PATH = "/api/v1/namespaces/data/configmaps/vault-index-state";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
interface ConfigMap { metadata?: { resourceVersion?: string }; data?: Record<string, string> }

/** 매일 KST 05:00의 마지막 도래 시각. 재시작해도 완료한 정기 실행은 반복하지 않는다. */
export function vaultScheduleKey(now: Date): string {
  return new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 한 프로세스가 순차 호출한다. 입력은 요청 식별자뿐이며 실행 경로는 고정이다. */
export async function runVaultIndexTick(opts: {
  now: Date;
  index: () => Promise<unknown>;
  request?: typeof k8sApi;
}): Promise<"idle" | "completed"> {
  const request = opts.request ?? k8sApi;
  const [signal, checkpoint] = await Promise.all([
    request("GET", VAULT_INDEX_REQUEST_PATH), request("GET", STATE_PATH),
  ]);
  if (signal.status !== 200 || checkpoint.status !== 200) throw new Error("VAULT_INDEX_STATE_READ_FAILED");
  const signalBody = signal.json as ConfigMap;
  const state = checkpoint.json as ConfigMap;
  const version = state?.metadata?.resourceVersion;
  if (typeof version !== "string" || !version) throw new Error("VAULT_INDEX_STATE_INVALID");
  const rawId = signalBody?.data?.requestId;
  if (rawId && (typeof rawId !== "string" || !UUID.test(rawId))) throw new Error("VAULT_INDEX_REQUEST_INVALID");
  const requestId = rawId || "";
  const scheduleKey = vaultScheduleKey(opts.now);
  if (requestId === (state.data?.completedRequestId ?? "") && state.data?.completedScheduleKey === scheduleKey) return "idle";

  await opts.index();
  // 인덱싱 도중 온 새 요청은 덮어쓰지 않는다. 별도 state에 시작 시점의 요청만 완료한다.
  const saved = await request("PATCH", STATE_PATH, {
    metadata: { resourceVersion: version },
    data: { completedRequestId: requestId, completedScheduleKey: scheduleKey },
  });
  if (saved.status !== 200) throw new Error("VAULT_INDEX_CHECKPOINT_WRITE_FAILED");
  return "completed";
}
