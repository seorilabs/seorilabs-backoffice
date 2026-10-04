import { prisma } from "@/lib/prisma";
import { createOperatorCommand } from "@/lib/discord/command-runs";
import { ephemeral, modal } from "@/lib/discord/responses";
import type { DiscordInteraction } from "@/lib/discord/types";
import { directApprovalEnabled, targetSchema } from "./policy";
export async function prepareDeploymentReview(interaction: DiscordInteraction, decision: string, id: string, reason = "") {
  if (!["approved", "rejected"].includes(decision)) return ephemeral("잘못된 처리 요청");
  const row = await prisma.deploymentApproval.findUnique({ where: { id } });
  if (!row || row.providerState !== "WAITING" || row.actionState !== "IDLE" || !row.targetHash || row.observationError) return ephemeral("현재 처리 가능한 승인 대기가 아닙니다. GitHub에서 상태를 확인하세요.");
  if (!directApprovalEnabled(row.environment)) return ephemeral("Discord 직접 처리는 아직 비활성 상태입니다.");
  const actorDiscordUserId = interaction.member?.user?.id ?? "";
  const link = await prisma.discordAccountLink.findUnique({ where: { discordUserId: actorDiscordUserId } });
  if (!link) return ephemeral("Backoffice 승인 페이지에서 연결 코드를 발급받아 /connect로 연결하세요.");
  if (decision === "rejected" && !reason) return modal(`papproval:rejected:${id}`, "플랫폼 배포 거절", "거절 사유");
  if (reason.length > 1000) return ephemeral("거절 사유는 1000자 이내로 입력하세요.");
  const run = await createOperatorCommand({ sourceInteractionId: interaction.id, operation: "platform_deployment_review", actorDiscordUserId, channelId: interaction.channel_id!, needsConfirmation: true, params: { approvalId: id, targetHash: row.targetHash, githubId: String(link.githubId), decision, reason } });
  const target = targetSchema.parse(row.target);
  return ephemeral(`${row.environment} · ${row.workflow} #${row.runNumber} · 재실행 ${row.runAttempt}\n소스 SHA: ${row.sourceSha}\n이미지 SHA: ${target.imageSha}\n대상: ${target.targets.join(", ")}\n${decision === "approved" ? "승인" : `거절 — ${reason}`}하시겠습니까? 10분 안에 본인만 확인할 수 있습니다.`, [{ type: 1, components: [{ type: 2, style: 4, label: "최종 확인", custom_id: `command:econfirm:${run.id}` }, { type: 2, style: 2, label: "취소", custom_id: `command:ecancel:${run.id}` }] }]);
}
