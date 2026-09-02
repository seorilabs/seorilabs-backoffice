import { createFleetP7GitHubReadbackAdapter } from "@/lib/control-plane/fleet-p7-github-readback";
import { createFleetP7RequestFetch, createFleetP7ScopedReadClient } from "@/lib/control-plane/fleet-p7-scoped-read-client";
import { getFleetScopedGithubTokenIssuer, readFleetGitHubAppPublicSource } from "@/lib/github/app";

async function main(): Promise<void> {
  const requestFetch = createFleetP7RequestFetch();
  const client = createFleetP7ScopedReadClient(await getFleetScopedGithubTokenIssuer({ requestFetch }));
  const observation = await createFleetP7GitHubReadbackAdapter({
    client, readAppSource: () => readFleetGitHubAppPublicSource({ requestFetch }),
  }).observeCurrentTargets();
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1, mode: "READ_ONLY_PROVIDER_OBSERVATION", authoritativeInventoryVerified: false,
    executionAllowed: false, repositoryMutations: 0, organizationSettingsMutations: 0, observation,
  })}\n`);
}

main().catch(() => {
  process.stderr.write("FLEET_P7_GITHUB_OBSERVATION_FAILED\n");
  process.exitCode = 1;
});
