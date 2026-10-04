import { kstDateTimeShort } from "@/lib/format/kst";
import type { DeploymentApproval } from "@prisma/client";
import type { DiscordActionRow } from "@/lib/notifications/discord";
import { directApprovalEnabled, targetSchema } from "./policy";
export function approvalCard(row: DeploymentApproval) {
  const url = `https://github.com/${row.repository}/actions/runs/${row.runId}/attempts/${row.runAttempt}`;
  const parsed = targetSchema.safeParse(row.target);
  const canAct = row.providerState === "WAITING" && row.actionState === "IDLE" && !!row.targetHash && !row.observationError && directApprovalEnabled(row.environment);
  const status = row.actionState === "UNKNOWN" || row.actionState === "SENDING" ? "처리 결과 확인 필요" : row.providerState === "WAITING" ? "승인 대기" : row.providerState === "IN_PROGRESS" ? "배포 진행 중" : row.providerState === "success" ? "배포 성공" : ({ NOT_PENDING: "승인 대기 해제 — 실행 상태 확인", SUPERSEDED: "새 재실행으로 대체됨", failure: "배포 실패", cancelled: "실행 취소", timed_out: "배포 시간 초과", action_required: "GitHub 추가 확인 필요", skipped: "배포 건너뜀" }[row.providerState] ?? "GitHub 결과 확인 필요");
  const text = [
    `**플랫폼 배포 · ${row.environment} · ${status}**`,
    `${row.workflow} #${row.runNumber} · 재실행 ${row.runAttempt}`,
    `소스 SHA: \`${row.sourceSha}\``,
    parsed.success ? `이미지 SHA: \`${parsed.data.imageSha}\`\n대상: ${parsed.data.targets.join(", ")}` : "배포 대상 확인 필요 — 직접 처리 차단",
    `대기 관측 시작: <t:${Math.floor(row.waitingSince.getTime() / 1000)}:f>`,
    row.actorLogin && row.decidedAt ? `${row.decision === "approved" ? "승인 확인" : "거절 확인"}: ${row.actorLogin} · ${kstDateTimeShort(row.decidedAt)}` : "",
    row.observationError ?? "",
    !directApprovalEnabled(row.environment) ? "Discord 직접 처리 비활성 · GitHub에서 처리할 수 있습니다." : "",
  ].filter(Boolean).join("\n");
  const components: DiscordActionRow[] = [{ type: 1, components: [
    { type: 2, style: 3, label: "승인", custom_id: `papproval:approved:${row.id}`, disabled: !canAct },
    { type: 2, style: 4, label: "거절", custom_id: `papproval:rejected:${row.id}`, disabled: !canAct },
    { type: 2, style: 5, label: "변경 내용 보기", url: `https://github.com/${row.repository}/commit/${parsed.success ? parsed.data.imageSha : row.sourceSha}` },
    { type: 2, style: 5, label: "GitHub에서 보기", url },
  ] }];
  return { text, components };
}
