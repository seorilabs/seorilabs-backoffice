import type { ReleaseStatus } from "@prisma/client";
import type { XcodeCloudBuildStatus } from "@/lib/xcode-cloud/status-shape";

export interface XcodeCloudSyncRow {
  id: string;
  status: ReleaseStatus;
  externalRunId: string;
}

export interface XcodeCloudSyncRowDeps {
  readStatus: (externalRunId: string) => Promise<XcodeCloudBuildStatus>;
  persistStatus: (input: {
    row: XcodeCloudSyncRow;
    result: XcodeCloudBuildStatus;
    terminal: boolean;
    statusChanged: boolean;
  }) => Promise<void>;
}

export async function syncXcodeCloudRow(
  row: XcodeCloudSyncRow,
  deps: XcodeCloudSyncRowDeps,
): Promise<{ terminal: boolean; status: ReleaseStatus }> {
  const result = await deps.readStatus(row.externalRunId);
  const terminal = result.status === "SUCCEEDED" || result.status === "FAILED";

  // status와 outbox는 하나의 트랜잭션에서 커밋해야 한다. 둘 중 하나만 남으면
  // terminal row가 pending 조회에서 빠지거나 알림 worker가 이전 상태를 읽을 수 있다.
  await deps.persistStatus({
    row,
    result,
    terminal,
    statusChanged: row.status !== result.status,
  });
  return { terminal, status: result.status };
}
