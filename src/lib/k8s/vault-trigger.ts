import { readFile } from "node:fs/promises";
import https from "node:https";

// backoffice(platform ns)에서 data ns 의 vault-indexer 인덱싱을 즉시 트리거.
// PVC 는 data ns 전속이라 backoffice 가 직접 인덱싱 못 함 → K8s API 로 Job 생성.
// 인증: 파드의 ServiceAccount 토큰 + 클러스터 CA(in-cluster). 의존성 없음(node:https).

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const NS = "data";
const CRONJOB = "vault-indexer";

interface K8sResponse {
  status: number;
  json: unknown;
}

async function k8sApi(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<K8sResponse> {
  let token: string;
  let ca: Buffer;
  try {
    [token, ca] = await Promise.all([
      readFile(`${SA_DIR}/token`, "utf8"),
      readFile(`${SA_DIR}/ca.crt`),
    ]);
  } catch {
    throw new Error("클러스터 내부가 아님(ServiceAccount 토큰 없음) — 트리거 불가");
  }
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise<K8sResponse>((resolve, reject) => {
    const req = https.request(
      `https://kubernetes.default.svc${apiPath}`,
      {
        method,
        ca,
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          Accept: "application/json",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
        timeout: 10_000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json: unknown = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("K8s API 타임아웃")));
    if (payload) req.write(payload);
    req.end();
  });
}

interface JobList {
  items?: Array<{ metadata?: { name?: string }; status?: { active?: number } }>;
}
interface CronJob {
  spec?: { jobTemplate?: { spec?: Record<string, unknown> } };
}

export interface TriggerResult {
  triggered: boolean;
  name: string;
  message: string;
}

/** vault-indexer 인덱싱 Job 즉시 생성. 이미 실행 중이면 중복 생성하지 않음. */
export async function triggerVaultIndex(): Promise<TriggerResult> {
  // 1) 이미 도는 인덱서(스케줄/수동) 있으면 중복 방지.
  const list = await k8sApi(
    "GET",
    `/apis/batch/v1/namespaces/${NS}/jobs?labelSelector=${encodeURIComponent("app.kubernetes.io/component=vault-indexer")}`,
  );
  if (list.status === 200) {
    const active = (list.json as JobList).items?.find(
      (j) => (j.status?.active ?? 0) > 0,
    );
    if (active) {
      return {
        triggered: false,
        name: active.metadata?.name ?? "?",
        message: "이미 인덱싱이 진행 중입니다.",
      };
    }
  }

  // 2) CronJob 의 jobTemplate 을 그대로 가져와 Job 으로 생성.
  const cj = await k8sApi(
    "GET",
    `/apis/batch/v1/namespaces/${NS}/cronjobs/${CRONJOB}`,
  );
  if (cj.status !== 200) {
    throw new Error(`vault-indexer CronJob 조회 실패 (status ${cj.status})`);
  }
  const tmpl = (cj.json as CronJob).spec?.jobTemplate?.spec;
  if (!tmpl) throw new Error("CronJob jobTemplate.spec 없음");

  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      generateName: "vault-index-discord-",
      namespace: NS,
      labels: {
        "app.kubernetes.io/name": "backoffice",
        "app.kubernetes.io/component": "vault-indexer",
        "vault-trigger": "manual",
      },
    },
    spec: {
      ...tmpl,
      activeDeadlineSeconds: 1800,
      ttlSecondsAfterFinished: 600, // 완료 후 자동 정리.
    },
  };

  const created = await k8sApi(
    "POST",
    `/apis/batch/v1/namespaces/${NS}/jobs`,
    job,
  );
  if (created.status >= 200 && created.status < 300) {
    const name =
      (created.json as { metadata?: { name?: string } }).metadata?.name ??
      "vault-index-discord";
    return { triggered: true, name, message: "인덱싱을 시작했습니다." };
  }
  throw new Error(
    `Job 생성 실패 (status ${created.status}): ${JSON.stringify(created.json).slice(0, 300)}`,
  );
}
