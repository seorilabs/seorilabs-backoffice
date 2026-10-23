import { readFileSync } from "node:fs";
import { request } from "node:https";
import { SERVICE_NAMESPACES } from "../src/lib/operations-batches/contract";
import { normalizeKubernetes } from "../src/lib/operations-batches/kubernetes";

const root = "/var/run/secrets/kubernetes.io/serviceaccount";
async function list(namespace: string, kind: "cronjobs" | "jobs"): Promise<unknown[]> {
  const token = readFileSync(`${root}/token`, "utf8").trim();
  const ca = readFileSync(`${root}/ca.crt`);
  const items: unknown[] = [];
  let cursor = "";
  do {
    const path = `/apis/batch/v1/namespaces/${namespace}/${kind}?limit=250${cursor ? `&continue=${encodeURIComponent(cursor)}` : ""}`;
    const page = await new Promise<{ items: unknown[]; metadata?: { continue?: string } }>((resolve, reject) => {
      const req = request({ hostname: "kubernetes.default.svc", port: 443, path, ca,
        headers: { authorization: `Bearer ${token}` }, timeout: 15_000 }, (res) => {
        const buffers: Buffer[] = []; let size = 0;
        res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 20_000_000) res.destroy(Error("BATCH_RESPONSE_TOO_LARGE")); else buffers.push(chunk); });
        res.on("error", reject);
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw Error("BATCH_PROVIDER_FAILED");
            const value = JSON.parse(Buffer.concat(buffers).toString());
            if (!Array.isArray(value.items)) throw Error("BATCH_PROVIDER_INVALID");
            resolve(value);
          } catch { reject(Error("BATCH_PROVIDER_FAILED")); }
        });
      });
      req.on("timeout", () => req.destroy(Error("BATCH_PROVIDER_TIMEOUT")));
      req.on("error", () => reject(Error("BATCH_PROVIDER_FAILED"))); req.end();
    });
    items.push(...page.items); cursor = page.metadata?.continue ?? "";
    if (items.length > 2000) throw Error("BATCH_INVENTORY_TOO_LARGE");
  } while (cursor);
  return items;
}

async function main() {
  const observedAt = new Date().toISOString();
  const results = await Promise.all(SERVICE_NAMESPACES.map(async (namespace) => {
    const [crons, jobs] = await Promise.all([list(namespace, "cronjobs"), list(namespace, "jobs")]);
    return normalizeKubernetes(namespace, crons, jobs);
  }));
  const token = process.env.INTERNAL_ADMIN_TOKEN;
  if (!token) throw Error("BATCH_CONFIGURATION_INVALID");
  const response = await fetch("http://backoffice.platform.svc.cluster.local/api/admin/operations/batch-results", {
    method: "POST", headers: { "x-admin-token": token, "content-type": "application/json" }, redirect: "error",
    body: JSON.stringify({ kind: "kubernetes", observedAt, cronJobs: results.flatMap((r) => r.cronJobs), runs: results.flatMap((r) => r.runs) }),
    signal: AbortSignal.timeout(58_000),
  });
  if (!response.ok || (await response.json()).ok !== true) throw Error("BATCH_RECORD_FAILED");
  console.log(JSON.stringify({ ok: true, cronJobs: results.reduce((n, r) => n + r.cronJobs.length, 0), runs: results.reduce((n, r) => n + r.runs.length, 0) }));
}
main().catch(() => { console.error(JSON.stringify({ ok: false, code: "BATCH_OBSERVATION_FAILED" })); process.exitCode = 1; });
