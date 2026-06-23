import { prisma } from "@/lib/prisma";
import { toggleIssueLabel, addIssueComment } from "@/lib/github/write";

// 세션 비의존 코어. 웹 서버액션(세션)과 텔레그램 핸들러(allowlist) 양쪽이 호출.
export async function toggleApprovalCore(input: {
  issueId: string;
  gate: "planning" | "release";
  on: boolean;
  reason?: string;
  actorLabel: string; // "@magicsih" | "telegram:123"
}): Promise<{ repoFullName: string; number: number; changed: boolean }> {
  const issue = await prisma.issueMirror.findUnique({
    where: { id: input.issueId },
  });
  if (!issue) throw new Error("issue not found");

  const label = `approval:${input.gate}`;
  const labels = new Set((issue.labels as string[]) ?? []);
  const has = labels.has(label);

  // 멱등/무결성 가드: 실제 상태 변경이 필요할 때만 동작.
  // (위조/중복 콜백으로 임의 이슈 라벨을 토글하거나 코멘트·오딧을 스팸하지 못하게)
  if (input.on === has) {
    return { repoFullName: issue.repoFullName, number: issue.number, changed: false };
  }

  await toggleIssueLabel({
    repoFullName: issue.repoFullName,
    issueNumber: issue.number,
    label,
    on: input.on,
  });
  if (input.reason) {
    await addIssueComment({
      repoFullName: issue.repoFullName,
      issueNumber: issue.number,
      body: `**승인 ${input.on ? "부여" : "회수"}** by ${input.actorLabel}\n\n${input.reason}`,
    });
  }

  if (input.on) labels.add(label);
  else labels.delete(label);
  await prisma.issueMirror.update({
    where: { id: issue.id },
    data: { labels: [...labels] },
  });

  await prisma.auditLog.create({
    data: {
      actorLogin: input.actorLabel,
      action: "issue.approval",
      entityType: "IssueMirror",
      entityId: issue.id,
      payload: { gate: input.gate, on: input.on },
    },
  });

  return { repoFullName: issue.repoFullName, number: issue.number, changed: true };
}
