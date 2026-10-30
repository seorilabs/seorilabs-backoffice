import { prisma } from "@/lib/prisma";
import { slackApi } from "@/lib/slack/api";
import { ensure, proposalSchema } from "./contracts";
import { supervisorSlackChannelId } from "./channel";
import { reservePublications, decideProposal } from "./service";
import { requireSlackOwner } from "./auth";
import type { SlackIngress } from "@/lib/slack/normalize";
const plain = (text: string) => ({ type: "plain_text", text, emoji: true });
export function proposalBlocks(p: {
  id: string;
  version: number;
  digest: string;
  title: string;
  payload: unknown;
}) {
  const body = proposalSchema.parse(p.payload);
  const key = `${p.id}:${p.version}:${p.digest}`;
  return [
    { type: "header", text: plain(p.title.slice(0, 150)) },
    { type: "section", text: plain(body.problem.slice(0, 2000)) },
    {
      type: "section",
      text: plain(
        (
          "실행할 테스트 명령\n" +
          body.testCommands.map((argv) => JSON.stringify(argv)).join("\n")
        ).slice(0, 2900),
      ),
    },
    {
      type: "context",
      elements: [
        plain(
          `검토본 ${p.version} · 예상 ${body.effortMinutes}분 · 상한 ${body.timeLimitMinutes}분 · ${body.release ? body.release.markets.join(", ") + " " + body.release.until : body.binding.kind === "files" ? "문서 적용과 확인까지" : "PR 병합까지"}`,
        ),
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: plain("진행"),
          style: "primary",
          action_id: `supervisor:approve:${key}`,
        },
        {
          type: "button",
          text: plain("7일 보류"),
          action_id: `supervisor:snooze:${key}`,
        },
        {
          type: "button",
          text: plain("제외"),
          action_id: `supervisor:exclude:${key}`,
        },
        {
          type: "button",
          text: plain("상세 보기"),
          url: `${process.env.AUTH_URL || "https://backoffice.vzyx.xyz"}/work/supervisor?id=${p.id}`,
          action_id: "supervisor:details",
        },
      ],
    },
  ];
}
export async function publishProposals() {
  const channel = supervisorSlackChannelId();
  ensure(channel, "SUPERVISOR_SLACK_CHANNEL_NOT_CONFIGURED", 503);
  const proposals = await reservePublications();
  const result = [];
  for (const proposal of proposals) {
    const sent = await slackApi("chat.postMessage", {
      channel,
      text: proposal.title,
      blocks: proposalBlocks(proposal),
    });
    // STARTED 예약은 자동 재전송하지 않는다. 응답 유실이면 Slack 이력 확인이 필요하다.
    await prisma.workProposal.update({
      where: { id: proposal.id },
      data: {
        deliveryState: sent.ok
          ? "SENT"
          : sent.error === "SLACK_DELIVERY_OUTCOME_UNKNOWN"
            ? "UNCERTAIN"
            : "FAILED",
        messageId: sent.messageId ?? null,
      },
    });
    result.push({
      id: proposal.id,
      state: sent.ok ? "SENT" : "NEEDS_READBACK",
    });
  }
  return result;
}
export async function handleSupervisorSlack(input: SlackIngress) {
  const actor = requireSlackOwner(input.context),
    action = input.interaction.data?.custom_id || "";
  if (action === "supervisor:details") return;
  const match =
    /^supervisor:(approve|snooze|exclude):([a-z0-9]+):(\d+):([a-f0-9]{64})$/.exec(
      action,
    );
  if (!match) throw new Error("SLACK_ACTION_INVALID");
  const proposal = await decideProposal({
    id: match[2],
    version: Number(match[3]),
    digest: match[4],
    decision: match[1] as "approve" | "snooze" | "exclude",
    actor,
  });
  await slackApi("chat.postEphemeral", {
    channel: input.context.channelId,
    user: input.context.userId,
    text:
      proposal.status === "APPROVED"
        ? "승인했습니다. PC 실행 대기열에 한 건을 등록했습니다."
        : proposal.status === "SNOOZED"
          ? "7일 동안 보류했습니다."
          : "제외했습니다.",
  });
}
