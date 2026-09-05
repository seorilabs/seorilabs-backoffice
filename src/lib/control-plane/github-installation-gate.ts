import { githubInstallationProviderPayloadSchema } from "@/lib/control-plane/github-installation-observation";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

export type CallerBootstrapGate = {
  state: "READY" | "BLOCKED";
  code: "READY" | "GITHUB_APP_MUTATION_CAPABILITY_MISSING";
  missing: string[];
};

/**
 * caller를 만드는 실행기는 모두 같은 GitHub App capability(callerBootstrapPullRequest)를
 * 요구한다. 실행기마다 다시 해석하면 한쪽만 완화될 수 있으므로 한 곳에서만 판정한다.
 */
export function callerBootstrapInstallationGate(payload: unknown): {
  installationId: string;
  gate: CallerBootstrapGate;
} {
  const parsed = githubInstallationProviderPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ControlPlaneError(
      "GitHub App installation observation이 strict v2 계약과 다릅니다.",
      409,
      "GITHUB_INSTALLATION_OBSERVATION_INVALID",
    );
  }
  const capability = parsed.data.attributes.capabilities.callerBootstrapPullRequest;
  return {
    installationId: parsed.data.attributes.installationId,
    gate: capability.state === "GRANTED"
      ? { state: "READY", code: "READY", missing: [] }
      : {
          state: "BLOCKED",
          code: "GITHUB_APP_MUTATION_CAPABILITY_MISSING",
          missing: [...capability.missing].sort(),
        },
  };
}

export async function readCallerBootstrapInstallationGate(
  appId: string,
  client: Pick<typeof prisma, "providerObservation"> = prisma,
): Promise<{ installationId: string; gate: CallerBootstrapGate }> {
  const observation = await client.providerObservation.findFirst({
    where: { appId, provider: "github", resourceType: "github-app-installation" },
    orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
  });
  if (!observation) {
    throw new ControlPlaneError(
      "GitHub App installation provider observation이 없습니다.",
      409,
      "GITHUB_INSTALLATION_OBSERVATION_MISSING",
    );
  }
  const installation = callerBootstrapInstallationGate(observation.payload);
  if (observation.resourceId !== installation.installationId) {
    throw new ControlPlaneError(
      "GitHub App installation public identity가 observation resource와 다릅니다.",
      409,
      "GITHUB_INSTALLATION_BINDING_MISMATCH",
    );
  }
  return installation;
}
