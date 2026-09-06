import { readFile } from "node:fs/promises";
import https from "node:https";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface K8sResponse {
  status: number;
  json: unknown;
}

export async function k8sApi(
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
            ? { "Content-Type": method === "PATCH" ? "application/merge-patch+json" : "application/json", "Content-Length": Buffer.byteLength(payload) }
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

