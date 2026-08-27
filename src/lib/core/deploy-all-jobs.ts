import type { ReleaseMarket, ReleaseStatus } from "@prisma/client";
import { parse as parseYaml } from "yaml";
import { marketFromWorkflowPath } from "@/lib/core/deploy-targets";

// deploy-all 실행 결과를 마켓별로 분해한다.
//
// deploy-all 은 마켓 배포를 재사용 워크플로 잡으로 호출하는데, 재사용 워크플로는 자체
// workflow_run 을 만들지 않는다. 실행 단위 결론만으로는 어느 마켓이 올라갔는지 알 수 없어
// 마켓 후속 작업(Play 프로덕션 승격, App Store 심사) 카드를 그릴 수 없다.
//
// 대신 GitHub 은 재사용 워크플로의 잡을 호출한 잡의 표시 이름을 접두사로 붙여 실행 잡 목록에
// 넣는다("Deploy Google Play / Upload AAB to Google Play internal track"). 접두사는 repo 마다
// 다르므로 추측하지 않고 deploy-all.yml 정의에서 잡 이름과 `uses` 대상 파일을 함께 읽어 맞춘다.

export interface DeployAllMarketJob {
  /** 실행 잡 이름의 접두사가 되는 caller 잡 표시 이름. */
  displayName: string;
  market: ReleaseMarket;
}

export interface DeployAllRunJob {
  name: string;
  conclusion: string | null;
}

export interface DeployAllMarketResult extends DeployAllMarketJob {
  status: Extract<ReleaseStatus, "SUCCEEDED" | "FAILED">;
}

interface WorkflowJobDefinition {
  name?: unknown;
  uses?: unknown;
}

/** deploy-all.yml 의 마켓 배포 caller 잡. `uses` 대상 파일로 마켓을 판별한다. */
export function parseDeployAllMarketJobs(text: string): DeployAllMarketJob[] {
  const doc = parseYaml(text) as { jobs?: Record<string, WorkflowJobDefinition> } | null;
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== "object") return [];
  const out: DeployAllMarketJob[] = [];
  for (const [key, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object") continue;
    const market = marketFromWorkflowPath(typeof job.uses === "string" ? job.uses : null);
    if (!market) continue;
    // 표시 이름을 생략한 잡은 GitHub 이 잡 키를 그대로 표시 이름으로 쓴다.
    const declared = typeof job.name === "string" ? job.name.trim() : "";
    out.push({ displayName: declared || key, market });
  }
  return out;
}

function jobBelongsTo(jobName: string, displayName: string): boolean {
  // 잡을 실행하지 않으면(skipped) 접두사 없이 caller 잡 이름만 남는다.
  return jobName === displayName || jobName.startsWith(`${displayName} / `);
}

/**
 * caller 잡 정의 + 실행 잡 결과 → 마켓별 배포 결론.
 *
 * 실행되지 않은 마켓(전부 skipped, 또는 잡 자체가 없음)은 배포 기록을 만들지 않는다.
 * 그 마켓은 이 실행에서 올라간 적이 없으므로 카드도 남기면 안 된다.
 */
export function deployAllMarketResults(
  definitions: DeployAllMarketJob[],
  runJobs: DeployAllRunJob[],
): DeployAllMarketResult[] {
  const out: DeployAllMarketResult[] = [];
  for (const definition of definitions) {
    const matched = runJobs.filter((job) => jobBelongsTo(job.name, definition.displayName));
    if (matched.some((job) => job.conclusion !== "success" && job.conclusion !== "skipped")) {
      out.push({ ...definition, status: "FAILED" });
      continue;
    }
    if (matched.some((job) => job.conclusion === "success")) {
      out.push({ ...definition, status: "SUCCEEDED" });
    }
  }
  return out;
}
