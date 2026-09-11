import { readBoundSecretFile } from "@/lib/control-plane/seori-auth-agent-transport";

// 승계 문서는 비밀값이 아니지만 mount 경계 밖 경로를 읽지 않도록 같은 bound reader를 쓴다.
const MAX_SUCCESSION_BYTES = 1024 * 1024;

function fail(code: string): never {
  throw new Error(code);
}

/**
 * ratified 기준선과 달라진 active cohort를 설명하는 서명된 승계 문서를 읽는다.
 *
 * 서명 검증은 여기서 하지 않고 collector가 신뢰 공개키로 수행한다. 이 함수는 mount
 * 경계 안의 문서를 객체로 돌려주기만 한다.
 */
export async function loadFleetMigrationBaselineSuccession(input: {
  root: string;
  file: string;
}): Promise<Record<string, unknown>> {
  const bytes = await readBoundSecretFile({
    root: input.root,
    relativePath: input.file,
    allowGroupRead: true,
    maxBytes: MAX_SUCCESSION_BYTES,
  });
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
    ) fail("FLEET_MIGRATION_BASELINE_SUCCESSION_DOCUMENT_INVALID");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw error instanceof Error && error.message.startsWith("FLEET_MIGRATION_")
      ? error
      : new Error("FLEET_MIGRATION_BASELINE_SUCCESSION_DOCUMENT_INVALID");
  } finally {
    bytes.fill(0);
  }
}
