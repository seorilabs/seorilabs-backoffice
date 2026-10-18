import { parseStableSemVerTag } from "@/lib/core/stable-semver";

type AuditRow = { entityId: string | null; payload: unknown };
type Run = { id: number; head_branch?: string | null; head_sha?: string | null; status?: string | null };
type Binding = { version: string; commitSha: string };

/** 제어 브랜치 HEAD는 빌드 소스가 아니다. dispatch 응답의 정확한 실행 ID로만 결합한다. */
export async function resolvePromotionRunBinding(
  repoFullName: string,
  run: Run,
  ports: {
    readAudit: (repo: string, runId: number) => Promise<AuditRow[]>;
    resolveTag: (repo: string, tag: string) => Promise<string>;
  },
): Promise<Binding | null> {
  const rows = await ports.readAudit(repoFullName, run.id);
  if (rows.length > 0) {
    const bindings: Binding[] = [];
    for (const row of rows) {
      const payload = row.payload as Record<string, unknown> | null;
      if (!payload || typeof payload !== "object" || payload.target !== "PLAY" || payload.to !== "production"
        || payload.workflowRunId !== String(run.id) || typeof payload.tag !== "string"
        || !parseStableSemVerTag(payload.tag) || row.entityId !== `${repoFullName}@${payload.tag}`
        || typeof payload.sha !== "string" || !/^[a-f0-9]{40}$/.test(payload.sha)) return null;
      bindings.push({ version: payload.tag, commitSha: payload.sha });
    }
    const first = bindings[0];
    return bindings.every(binding => binding.version === first.version && binding.commitSha === first.commitSha) ? first : null;
  }
  // 이전 태그 ref에서 직접 실행한 기록도 정확한 태그 SHA를 사용한다.
  if (run.head_branch && parseStableSemVerTag(run.head_branch)) {
    return { version: run.head_branch, commitSha: await ports.resolveTag(repoFullName, run.head_branch) };
  }
  // webhook이 감사 저장보다 먼저 왔거나 외부 실행이라 결합이 없으면 추측하지 않는다.
  // raw workflow 미러는 남아 정기 reconcile이 같은 실행을 다시 확인한다.
  return null;
}
