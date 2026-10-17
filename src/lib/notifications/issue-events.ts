import type { Priority } from "@prisma/client";

export type IssueEventAction = "opened" | "closed";
export function issueUrl(repoFullName: string, number: number): string {
  return `https://github.com/${repoFullName}/issues/${number}`;
}
/** GitHub 정본의 상태 전환을 보고하며 이슈 종료를 실제 사용자 피해 복구로 추정하지 않는다. */
export function issueEventReport(input: {
  action: IssueEventAction;
  repoFullName: string;
  appName: string;
  number: number;
  title: string;
  priority: Priority | null;
  stateReason?: string | null;
  updatedAt: string;
}) {
  const important = input.priority === "P1";
  const conclusion =
    input.action === "opened"
      ? "우선 처리할 문제가 등록됐습니다."
      : input.stateReason === "not_planned"
        ? "우선 처리 항목을 미진행으로 닫았습니다."
        : input.stateReason === "duplicate"
          ? "우선 처리 항목을 중복으로 닫았습니다."
          : "우선 처리 항목을 완료로 닫았습니다.";
  const title =
    input.title.trim().replace(/[[\]]/g, "").slice(0, 120) ||
    `#${input.number}`;
  return {
    dedupeKey: `github-issue-event:${input.repoFullName}:${input.number}:${input.action}:${input.updatedAt}`,
    payload: {
      text: `**${input.appName} · ${important ? conclusion : "개발 이슈 상태를 기록했습니다."}**\n[${title}](${issueUrl(input.repoFullName, input.number)})`,
      report: {
        category: important ? "change" : "internal",
        reason: important
          ? "IMPORTANT_DEVELOPMENT_CHANGE"
          : "ISSUE_OBSERVATION",
      },
    },
  };
}
