import { readFleetGitHubAppPublicSource } from "@/lib/github/app";

// Run inside the existing trusted Backoffice runtime. No tokens, payloads,
// signature headers, secrets, installation-token issuance, or provider writes.
readFleetGitHubAppPublicSource().then((source) => {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    state: "GITHUB_APP_PUBLIC_SOURCE_READBACK",
    source,
    webhookDeliveryVerified: source.app.webhookActive,
    repositoryEventAcceptanceVerified: false,
    externalMutations: 0,
    installationTokensCreated: 0,
  })}\n`);
}).catch(() => {
  process.stderr.write("GITHUB_APP_PUBLIC_STATE_READ_FAILED\n");
  process.exitCode = 1;
});
