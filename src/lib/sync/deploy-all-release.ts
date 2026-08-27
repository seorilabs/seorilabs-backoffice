import type { ReleaseMarket, ReleaseStatus } from "@prisma/client";
import { MARKET_WORKFLOW } from "@/lib/core/deploy-targets";
import {
  deployAllMarketResults,
  parseDeployAllMarketJobs,
  type DeployAllMarketResult,
  type DeployAllRunJob,
} from "@/lib/core/deploy-all-jobs";
import { buildDeployAllStatusCardText } from "@/lib/notifications/deploy-format";
import { releaseTrackForWorkflow } from "@/lib/sync/release-status";

// deploy-all 실행 → 마켓별 배포 기록. 미러(prisma·octokit)와 분리해 폴백 분기를 단위 테스트한다.

export interface MarketReleaseInput {
  appId: string;
  market: ReleaseMarket;
  version: string;
  track: string | null;
  status: ReleaseStatus;
  workflowName: string | null;
  commitSha: string | null;
  runId: bigint;
  runAttempt: number;
  runUrl: string;
  ghUpdatedAt: Date;
}

export interface DeployAllRunContext {
  repoFullName: string;
  appId: string;
  /** 실행 워크플로 표시 이름. 마켓 카드의 "실행" 줄에 caller 잡 이름과 함께 남는다. */
  workflowName: string | null;
  headSha: string | null;
  version: string;
  status: Extract<ReleaseStatus, "SUCCEEDED" | "FAILED">;
  runId: bigint;
  runAttempt: number;
  runUrl: string;
  ghUpdatedAt: Date;
}

export interface DeployAllReleaseDeps {
  readWorkflowFile(repoFullName: string, workflowFile: string, ref?: string): Promise<string>;
  listRunJobs(repoFullName: string, runId: bigint, runAttempt: number): Promise<DeployAllRunJob[]>;
  recordMarketRelease(input: MarketReleaseInput): Promise<void>;
  appDisplayName(appId: string): Promise<string | null>;
  enqueueRunResultCard(input: { text: string; eventKey: string; occurredAt: Date }): Promise<void>;
}

/**
 * deploy-all 실행의 마켓별 배포 기록.
 *
 * 마켓 잡은 재사용 워크플로라 자체 workflow_run 이 없다. 실행의 잡 목록으로 마켓별 결론을
 * 복원해 단일 마켓 배포와 같은 카드(프로덕션 승격·심사 버튼 포함)를 남긴다. 잡을 읽지
 * 못했거나 마켓 잡이 하나도 돌지 않았으면 ALL 배포가 무음으로 끝나지 않게 실행 단위 카드로
 * 물러선다.
 *
 * 반환: 기록한 마켓 결과. 빈 배열이면 실행 단위 카드로 물러섰다는 뜻이다.
 */
export async function recordDeployAllRun(
  context: DeployAllRunContext,
  deps: DeployAllReleaseDeps,
): Promise<DeployAllMarketResult[]> {
  let results: DeployAllMarketResult[] = [];
  try {
    const [definition, jobs] = await Promise.all([
      deps.readWorkflowFile(
        context.repoFullName,
        MARKET_WORKFLOW.ALL,
        context.headSha ?? undefined,
      ),
      deps.listRunJobs(context.repoFullName, context.runId, context.runAttempt),
    ]);
    results = deployAllMarketResults(parseDeployAllMarketJobs(definition), jobs);
  } catch (error) {
    console.error(
      "[mirror] deploy-all 마켓 결과 분해 실패:",
      error instanceof Error ? error.message : error,
    );
  }

  if (results.length === 0) {
    await deps.enqueueRunResultCard({
      text: buildDeployAllStatusCardText({
        displayName: (await deps.appDisplayName(context.appId)) ?? context.repoFullName,
        version: context.version,
        status: context.status,
        runUrl: context.runUrl,
        updatedAt: context.ghUpdatedAt,
      }),
      eventKey: `${context.runId}:${context.runAttempt}`,
      occurredAt: context.ghUpdatedAt,
    });
    return results;
  }

  for (const result of results) {
    await deps.recordMarketRelease({
      appId: context.appId,
      market: result.market,
      version: context.version,
      track: releaseTrackForWorkflow({
        market: result.market,
        promoted: false,
        version: context.version,
      }),
      status: result.status,
      workflowName: `${context.workflowName ?? "Deploy All"} / ${result.displayName}`,
      commitSha: context.headSha,
      runId: context.runId,
      runAttempt: context.runAttempt,
      runUrl: context.runUrl,
      ghUpdatedAt: context.ghUpdatedAt,
    });
  }
  return results;
}
