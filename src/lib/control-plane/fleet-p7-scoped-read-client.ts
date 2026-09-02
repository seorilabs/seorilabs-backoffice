import type { FleetP7ReadClient } from "@/lib/control-plane/fleet-p7-github-readback";
import { withFleetScopedGithubClient, type FleetScopedGithubTokenIssuer, type FleetGitHubCapability } from "@/lib/github/scoped-installation-client";

/** Also binds JWT exchange and token revocation, before any authorization header is sent. */
export function createFleetP7RequestFetch(transport: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash) {
      throw new Error("FLEET_P7_API_ORIGIN_REJECTED");
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return transport(input, { ...init, redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  };
}

const routes: Readonly<Record<string, FleetGitHubCapability>> = {
  "GET /repositories/{repository_id}": "github.fleet-migration.shadow-read",
  "GET /repos/{owner}/{repo}/git/ref/{ref}": "github.fleet-migration.shadow-read",
  "GET /repos/{owner}/{repo}/contents/{path}": "github.fleet-migration.shadow-read",
  "GET /orgs/{org}": "github.fleet-p7.organization-read",
  "GET /orgs/{org}/properties/schema": "github.fleet-p7.properties-read",
  "GET /repos/{owner}/{repo}/branches/{branch}/protection": "github.fleet-p7.protection-read",
  "GET /repos/{owner}/{repo}/rules/branches/{branch}": "github.fleet-p7.protection-read",
};

/** Each GET gets one repository-bound read-only token, revoked before returning. */
export function createFleetP7ScopedReadClient<Client extends FleetP7ReadClient>(input: {
  installationId: string;
  issuer: FleetScopedGithubTokenIssuer<Client>;
  now?: () => Date;
}): FleetP7ReadClient {
  if (input.installationId !== "142120077") throw new Error("FLEET_P7_INSTALLATION_MISMATCH");
  return {
    async request(route, parameters = {}, scope) {
      const capability = routes[route];
      if (!capability || !scope) throw new Error("FLEET_P7_READ_SCOPE_REQUIRED");
      const [owner, repo] = scope.fullName.split("/");
      const allowedParameters = new Set(["repository_id", "owner", "repo", "ref", "path", "branch", "org", "baseUrl", "headers", "request"]);
      if (Object.keys(parameters).some((key) => !allowedParameters.has(key))
        || route.endsWith("/git/ref/{ref}") && parameters.ref !== "heads/main"
        || route.includes("/branches/") && parameters.branch !== "main"
        || route.endsWith("/contents/{path}") && (
          !/^[a-f0-9]{40}$/u.test(String(parameters.ref ?? ""))
          || parameters.path !== (scope.fullName === "seorilabs/.github"
            ? "contracts/fleet-p3-runtime.yaml" : ".github/workflows/org-contract.yml"))) {
        throw new Error("FLEET_P7_READ_SCOPE_MISMATCH");
      }
      if (owner !== "seorilabs"
        || route.startsWith("GET /orgs/") && (parameters.org !== owner
          || scope.repositoryId !== "1241442018" || scope.fullName !== "seorilabs/.github")
        || route.startsWith("GET /repos/") && (parameters.owner !== owner || parameters.repo !== repo)
        || route === "GET /repositories/{repository_id}" && String(parameters.repository_id) !== scope.repositoryId) {
        throw new Error("FLEET_P7_READ_SCOPE_MISMATCH");
      }
      return withFleetScopedGithubClient({
        ...input, capability, repositoryId: scope.repositoryId, repositoryFullName: scope.fullName,
        execute: (client) => client.request(route, {
          ...parameters, baseUrl: "https://api.github.com", headers: { "X-GitHub-Api-Version": "2026-03-10" },
          request: { redirect: "error", signal: AbortSignal.timeout(15_000) },
        }),
      });
    },
  };
}
