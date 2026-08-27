import {
  LEGACY_SOURCE_DEFINITIONS,
  LEGACY_TRANSFORM_VERSION,
} from "@/lib/control-plane/legacy-sources";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

/** 원래 key를 DB에 남기지 않고 scope가 분리된 고정 길이 lookup key만 보존한다. */
export function hashLegacyShadowIdempotencyKey(idempotencyKey: string): string {
  return jsonDigest({ scope: "legacy-shadow-import", idempotencyKey } as JsonValue);
}

export function legacyShadowRequestHash(input: {
  repoId: bigint;
  sourceSha: string;
  observedBy: string;
}): string {
  return jsonDigest({
    repoId: input.repoId.toString(),
    sourceSha: input.sourceSha.toLowerCase(),
    observedBy: input.observedBy,
    transformVersion: LEGACY_TRANSFORM_VERSION,
    sourceVector: LEGACY_SOURCE_DEFINITIONS.map((source) => ({
      sourceKind: source.sourceKind,
      repositoryScope: source.repositoryScope,
      pathPattern: source.pathPattern,
      format: source.format,
    })),
  } as JsonValue);
}
