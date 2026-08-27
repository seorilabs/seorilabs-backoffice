import type { Priority } from "@prisma/client";

// GitHub 이슈 생성·종료 Discord 알림 문구. webhook 라우트에서 분리해 단위 테스트한다.

export type IssueEventAction = "opened" | "closed";

const TITLE_LIMIT = 120;

/** 종료 사유 → 표시 라벨. GitHub 이 사유를 비워 보내는 종료는 처리완료로 본다. */
const CLOSE_LABEL: Record<string, string> = {
  completed: "✅ **처리완료**",
  not_planned: "🚫 **미진행 종료**",
  duplicate: "♻️ **중복 종료**",
};

export function issueUrl(repoFullName: string, number: number): string {
  return `https://github.com/${repoFullName}/issues/${number}`;
}

// 대괄호가 들어간 제목은 markdown 링크 문법을 깨뜨려 링크가 통째로 사라진다.
function linkText(text: string): string {
  return text.replace(/[[\]]/g, "");
}

function headline(input: {
  action: IssueEventAction;
  priority: Priority | null;
  stateReason?: string | null;
}): string {
  if (input.action === "closed") {
    return CLOSE_LABEL[input.stateReason ?? ""] ?? CLOSE_LABEL.completed;
  }
  // 즉시 대응이 필요한 P1 은 생성 알림에서 계속 구분해 둔다.
  return input.priority === "P1" ? "🔥 **새 P1**" : "🆕 **새 이슈**";
}

export function issueEventMessage(input: {
  action: IssueEventAction;
  repoFullName: string;
  number: number;
  title: string;
  priority: Priority | null;
  stateReason?: string | null;
}): string {
  const repo = input.repoFullName.replace(/^[^/]+\//, "");
  const badge = input.priority ? ` · ${input.priority}` : "";
  const title = linkText(input.title.trim()).slice(0, TITLE_LIMIT) || `#${input.number}`;
  return (
    `${headline(input)}${badge}\n` +
    `[${repo} #${input.number} ${title}](${issueUrl(input.repoFullName, input.number)})`
  );
}
