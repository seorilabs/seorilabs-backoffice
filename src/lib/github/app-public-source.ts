import {
  normalizeGitHubInstallationPublicState,
  type GitHubInstallationPublicState,
} from "@/lib/github/installation-public-state";

export interface FleetGitHubAppPublicSource {
  observedAt: string;
  app: {
    id: string;
    slug: string;
    ownerId: string;
    ownerLogin: string;
    active: boolean;
    /** Verified recent delivery, not an administrative toggle (GitHub exposes none). */
    webhookActive: boolean;
    webhookUrl: string;
    permissions: Record<string, "read" | "write" | "admin">;
    events: string[];
  };
  installation: GitHubInstallationPublicState & {
    updatedAt: string;
    suspendedAt: string | null;
  };
}

interface PublicReadClient {
  request(route: string, parameters?: Record<string, unknown>): Promise<{ data: unknown }>;
}

const MAX_DELIVERY_AGE_MS = 15 * 60_000;
type JsonObject = Record<string, unknown>;

function invalid(): never {
  throw new Error("GITHUB_APP_PUBLIC_STATE_INVALID");
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as JsonObject;
}

function publicId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  // The pinned Octokit request parser preserves 64-bit GitHub IDs as bigint.
  if (typeof value === "bigint" && value > 0n && value < 10n ** 32n) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,31}$/u.test(value)) return value;
  return invalid();
}

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return invalid();
  return Date.parse(value);
}

function exactPublicPermissions(value: unknown): Record<string, "read" | "write" | "admin"> {
  const entries = Object.entries(object(value)).map(([name, access]) => {
    if (!/^[a-z][a-z0-9_]{0,127}$/u.test(name)
      || (access !== "read" && access !== "write" && access !== "admin")) return invalid();
    return [name, access] as const;
  }).sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function exactPublicEvents(value: unknown): string[] {
  if (!Array.isArray(value)) return invalid();
  const events = value.map((event) => {
    if (typeof event !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(event)) return invalid();
    return event;
  }).sort();
  if (new Set(events).size !== events.length) return invalid();
  return events;
}

async function verifiedWebhookDelivery(client: PublicReadClient, input: {
  installationId: string; webhookUrl: string; configurationUpdatedAt: number; now: number;
}): Promise<boolean> {
  const { data: response } = await client.request("GET /app/hook/deliveries", { per_page: 100 });
  if (!Array.isArray(response) || response.length > 100) return invalid();
  const deliveries = response.map(object)
    .filter((delivery) => delivery.installation_id !== null && publicId(delivery.installation_id) === input.installationId)
    .sort((left, right) => timestamp(right.delivered_at) - timestamp(left.delivered_at)
      || (BigInt(publicId(right.id)) > BigInt(publicId(left.id)) ? 1 : -1));
  const latest = deliveries[0];
  if (!latest) return false;
  const deliveredAt = timestamp(latest.delivered_at);
  if (deliveredAt < input.configurationUpdatedAt || deliveredAt > input.now
    || input.now - deliveredAt > MAX_DELIVERY_AGE_MS
    || typeof latest.status_code !== "number" || !Number.isInteger(latest.status_code)
    || latest.status_code < 200 || latest.status_code >= 300) return false;
  const deliveryId = publicId(latest.id);
  const detail = object((await client.request("GET /app/hook/deliveries/{delivery_id}", { delivery_id: deliveryId })).data);
  // Never return request/response bodies, signature headers, or webhook secrets.
  return publicId(detail.id) === deliveryId && detail.guid === latest.guid
    && typeof latest.guid === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(latest.guid)
    && publicId(detail.installation_id) === input.installationId
    && detail.repository_id === latest.repository_id && detail.event === latest.event
    && detail.delivered_at === latest.delivered_at && detail.status_code === latest.status_code
    && detail.url === input.webhookUrl;
}

/** App JWT stays in Octokit; only allowlisted public source fields leave this boundary. */
export async function readGitHubAppPublicSource(client: PublicReadClient, org: string, now: () => Date = () => new Date()): Promise<FleetGitHubAppPublicSource> {
  try {
    const publicClient: PublicReadClient = {
      request: (route, parameters) => client.request(route, {
        ...parameters,
        headers: { "X-GitHub-Api-Version": "2026-03-10" },
        request: { redirect: "error", signal: AbortSignal.timeout(15_000) },
      }),
    };
    const [appResponse, installationResponse, webhookResponse] = await Promise.all([
      publicClient.request("GET /app"),
      publicClient.request("GET /orgs/{org}/installation", { org }),
      publicClient.request("GET /app/hook/config"),
    ]);
    const app = object(appResponse.data);
    const owner = object(app.owner);
    const hook = object(webhookResponse.data);
    const installationData = object(installationResponse.data);
    const installation = normalizeGitHubInstallationPublicState(installationData);
    const appId = publicId(app.id);
    const ownerId = publicId(owner.id);
    const appUpdatedAt = timestamp(app.updated_at);
    const installationUpdatedAt = timestamp(installationData.updated_at);
    const suspendedAt = installationData.suspended_at === null ? null
      : new Date(timestamp(installationData.suspended_at)).toISOString();
    if (typeof app.slug !== "string" || typeof owner.login !== "string"
      || installation.appId !== appId || installation.targetId !== ownerId
      || owner.login !== org || installation.accountLogin !== org
      || typeof hook.url !== "string") return invalid();
    const url = new URL(hook.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return invalid();
    const observedAt = now();
    const configurationUpdatedAt = Math.max(appUpdatedAt, installationUpdatedAt);
    if (!Number.isFinite(observedAt.getTime()) || configurationUpdatedAt > observedAt.getTime()) return invalid();
    const webhookActive = !installation.suspended && hook.content_type === "json" && hook.insecure_ssl === "0"
      && await verifiedWebhookDelivery(publicClient, {
        installationId: installation.installationId, webhookUrl: hook.url,
        configurationUpdatedAt, now: observedAt.getTime(),
      });
    return {
      observedAt: observedAt.toISOString(),
      app: {
        id: appId, slug: app.slug, ownerId, ownerLogin: owner.login,
        active: !installation.suspended, webhookActive, webhookUrl: hook.url,
        permissions: exactPublicPermissions(app.permissions), events: exactPublicEvents(app.events),
      },
      installation: { ...installation, updatedAt: new Date(installationUpdatedAt).toISOString(), suspendedAt },
    };
  } catch {
    // Octokit errors may include request headers and credentials. Do not propagate them.
    throw new Error("GITHUB_APP_PUBLIC_STATE_READ_FAILED");
  }
}
