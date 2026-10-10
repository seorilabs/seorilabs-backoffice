import { z } from "zod";

const sdkVersion = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);

const sdkConsumerSchema = z.object({
  integration: z.literal("SDK"),
  artifactKind: z.enum(["TYPESCRIPT", "GDSCRIPT"]),
  observedVersion: sdkVersion,
  lockIntegrity: z.string().regex(/^(?:sha256-[A-Za-z0-9+/]{43}=|sha512-[A-Za-z0-9+/]{86}==)$/).optional(),
  treeChecksum: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const nonSdkConsumerSchema = z.object({
  integration: z.enum(["CUSTOM_HTTP", "MISSING"]),
});

export type PlatformSdkObservation =
  | {
      integration: "SDK";
      artifactKind: "TYPESCRIPT" | "GDSCRIPT";
      version: string;
      checksum: string | null;
    }
  | { integration: "CUSTOM_HTTP" | "MISSING" };

/**
 * DiscoveryObservation payload의 platformConsumer에서 앱 소스가 실제로 고정한 공통 기능 SDK를 읽는다.
 * 관측 사실만 투영하며 버전이 적절한지는 판단하지 않는다. 형식이 맞지 않으면 추측하지 않고 null이다.
 */
export function platformSdkObservationFromDiscovery(payload: unknown): PlatformSdkObservation | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const consumer = (payload as Record<string, unknown>).platformConsumer;
  const sdk = sdkConsumerSchema.safeParse(consumer);
  if (sdk.success) {
    return {
      integration: "SDK",
      artifactKind: sdk.data.artifactKind,
      version: sdk.data.observedVersion,
      checksum: (sdk.data.artifactKind === "TYPESCRIPT" ? sdk.data.lockIntegrity : sdk.data.treeChecksum) ?? null,
    };
  }
  const other = nonSdkConsumerSchema.safeParse(consumer);
  return other.success ? { integration: other.data.integration } : null;
}
