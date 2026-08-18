import { Prisma, type OperatorCommandRun } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createBugDraftCore, createPlanningDraftCore, commitDraftCore } from "@/lib/core/ai-drafts";
import { generateStageDraftCore } from "@/lib/core/ai-drafts";
import { toggleApprovalCore } from "@/lib/core/approvals";
import {
  createReleaseTagWithNotes,
  dispatchMarketDeploy,
  previewNextTag,
  type Bump,
  type DeployTarget,
} from "@/lib/core/release-ops";
import { enqueueVaultWrite } from "@/lib/vault/write-core";
import { triggerVaultIndex } from "@/lib/k8s/vault-trigger";
import { handleDiscordChat } from "@/lib/discord/chat";
import {
  createDiscordChannelMessage,
  editDiscordChannelMessage,
  type DiscordActionRow,
} from "@/lib/notifications/discord";
import { acknowledgeIncident, incidentComponents, incidentMessage } from "@/lib/notifications/incidents";

const CONFIRM_TTL_MS = 10 * 60_000;
const RESULT_TTL_MS = 24 * 60 * 60_000;
const STALE_MS = 10 * 60_000;

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: Prisma.JsonValue | null): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(input: JsonRecord, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "알 수 없는 오류";
  return message
    .replace(/Bot\s+\S+/gi, "Bot [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[REDACTED]")
    .slice(0, 500);
}

export async function createOperatorCommand(input: {
  sourceInteractionId: string;
  appId?: string;
  operation: string;
  params?: Prisma.InputJsonObject;
  actorDiscordUserId: string;
  channelId: string;
  messageId?: string;
  needsConfirmation?: boolean;
}) {
  const actorLabel = `discord:${input.actorDiscordUserId}`;
  return prisma.operatorCommandRun.upsert({
    where: { sourceInteractionId: input.sourceInteractionId },
    create: {
      sourceInteractionId: input.sourceInteractionId,
      appId: input.appId,
      operation: input.operation,
      params: input.params,
      actorDiscordUserId: input.actorDiscordUserId,
      actorLabel,
      channelId: input.channelId,
      messageId: input.messageId,
      status: input.needsConfirmation ? "AWAITING_CONFIRMATION" : "PENDING",
      ...(input.needsConfirmation ? {} : { confirmedAt: new Date() }),
      expiresAt: new Date(Date.now() + (input.needsConfirmation ? CONFIRM_TTL_MS : RESULT_TTL_MS)),
    },
    update: {},
  });
}

export async function confirmOperatorCommand(input: {
  id: string;
  actorDiscordUserId: string;
  channelId: string;
  messageId?: string;
}): Promise<boolean> {
  const now = new Date();
  const changed = await prisma.operatorCommandRun.updateMany({
    where: {
      id: input.id,
      actorDiscordUserId: input.actorDiscordUserId,
      status: "AWAITING_CONFIRMATION",
      expiresAt: { gt: now },
    },
    data: {
      status: "PENDING",
      confirmedAt: now,
      channelId: input.channelId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      expiresAt: new Date(now.getTime() + RESULT_TTL_MS),
    },
  });
  return changed.count === 1;
}

export async function cancelOperatorCommand(input: {
  id: string;
  actorDiscordUserId: string;
}): Promise<boolean> {
  const changed = await prisma.operatorCommandRun.updateMany({
    where: {
      id: input.id,
      actorDiscordUserId: input.actorDiscordUserId,
      status: "AWAITING_CONFIRMATION",
    },
    data: { status: "CANCELLED", completedAt: new Date(), params: Prisma.DbNull },
  });
  return changed.count === 1;
}

function confirmationRows(runId: string): DiscordActionRow[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 4, label: "실행", custom_id: `command:confirm:${runId}` },
      { type: 2, style: 2, label: "취소", custom_id: `command:cancel:${runId}` },
    ],
  }];
}

function draftRows(draftId: string): DiscordActionRow[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "이슈 생성", custom_id: `draft:commit:${draftId}` },
      { type: 2, style: 2, label: "취소", custom_id: `draft:cancel:${draftId}` },
    ],
  }];
}

const STAGE_DRAFT_KINDS = new Set([
  "TASK_BREAKDOWN",
  "QA_CHECKLIST",
  "RELEASE_NOTES",
  "STORE_COPY",
  "IMPROVEMENT_HYPOTHESIS",
]);

async function showRun(
  run: Pick<OperatorCommandRun, "id" | "channelId" | "messageId">,
  text: string,
  components: DiscordActionRow[] = [],
): Promise<string | null> {
  if (run.messageId) {
    const edited = await editDiscordChannelMessage(run.channelId, run.messageId, text, { components });
    if (edited.ok) return run.messageId;
  }
  const created = await createDiscordChannelMessage(run.channelId, text, { components });
  return created.ok ? created.messageId ?? null : null;
}

async function appForRun(run: OperatorCommandRun) {
  if (!run.appId) throw new Error("앱이 지정되지 않았습니다.");
  const app = await prisma.app.findUnique({
    where: { id: run.appId },
    select: { id: true, slug: true, displayName: true, repoFullName: true, marketTargets: true },
  });
  if (!app) throw new Error("앱을 찾을 수 없습니다.");
  return app;
}

async function execute(run: OperatorCommandRun): Promise<{ summary: string; awaiting?: boolean; messageId?: string | null }> {
  const params = jsonRecord(run.params);
  switch (run.operation) {
    case "plan_generate": {
      const app = await appForRun(run);
      const draft = await createPlanningDraftCore({
        appId: app.id,
        idea: stringValue(params, "text"),
        actorLabel: run.actorLabel,
      });
      const messageId = await showRun(
        run,
        `📝 **${draft.title}**\n\n${draft.outputText.slice(0, 3_500)}${draft.outputText.length > 3_500 ? "\n…" : ""}`,
        draftRows(draft.id),
      );
      return { summary: `기획 초안 생성: ${draft.title}`, messageId };
    }
    case "bug_generate": {
      const app = await appForRun(run);
      const draft = await createBugDraftCore({
        appId: app.id,
        symptom: stringValue(params, "text"),
        actorLabel: run.actorLabel,
      });
      const messageId = await showRun(
        run,
        `🐞 **${draft.title}**\n\n${draft.outputText.slice(0, 3_500)}${draft.outputText.length > 3_500 ? "\n…" : ""}`,
        draftRows(draft.id),
      );
      return { summary: `버그 초안 생성: ${draft.title}`, messageId };
    }
    case "stage_generate": {
      const app = await appForRun(run);
      const kind = stringValue(params, "kind");
      if (!STAGE_DRAFT_KINDS.has(kind)) throw new Error("지원하지 않는 초안 종류입니다.");
      let issueNumber: number | undefined;
      if (kind === "TASK_BREAKDOWN" || kind === "QA_CHECKLIST") {
        const issue = await prisma.issueMirror.findFirst({
          where: { appId: app.id, state: "OPEN" },
          orderBy: { ghUpdatedAt: "desc" },
          select: { number: true },
        });
        if (!issue) throw new Error("열린 이슈가 없어 초안을 만들 수 없습니다.");
        issueNumber = issue.number;
      }
      const draft = await generateStageDraftCore({
        appId: app.id,
        kind: kind as Parameters<typeof generateStageDraftCore>[0]["kind"],
        issueNumber,
        actorLabel: run.actorLabel,
      });
      const messageId = await showRun(
        run,
        `📝 **${draft.title ?? "AI 초안"}**\n\n${draft.outputText.slice(0, 3_500)}${draft.outputText.length > 3_500 ? "\n…" : ""}`,
        draftRows(draft.id),
      );
      return { summary: `단계 초안 생성: ${draft.title ?? kind}`, messageId };
    }
    case "draft_commit": {
      const draftId = stringValue(params, "draftId");
      const draft = await prisma.aiDraft.findUnique({ where: { id: draftId }, select: { createdBy: true } });
      if (!draft || draft.createdBy !== run.actorLabel) throw new Error("본인이 만든 초안만 반영할 수 있습니다.");
      const result = await commitDraftCore({ draftId, actorLabel: run.actorLabel });
      await showRun(run, `✅ 이슈 생성 완료: [${result.repoFullName} #${result.issueNumber}](${result.url})`);
      return { summary: `이슈 #${result.issueNumber} 생성` };
    }
    case "approval": {
      const result = await toggleApprovalCore({
        issueId: stringValue(params, "issueId"),
        gate: stringValue(params, "gate") as "planning" | "release",
        on: false,
        reason: "Discord에서 승인",
        actorLabel: run.actorLabel,
      });
      await showRun(run, `✅ ${result.repoFullName} #${result.number} 승인 처리${result.changed ? "" : " (이미 승인됨)"}`);
      return { summary: `승인 #${result.number}` };
    }
    case "incident_ack":
    case "incident_assign": {
      const incident = await acknowledgeIncident(
        stringValue(params, "incidentId"),
        run.actorDiscordUserId,
        run.operation === "incident_assign",
      );
      const messageId = await showRun(run, incidentMessage(incident), incidentComponents(incident));
      return { summary: run.operation === "incident_assign" ? "장애 담당 지정" : "장애 확인", messageId };
    }
    case "release_preview": {
      const app = await appForRun(run);
      const bump = stringValue(params, "bump") as Bump;
      const preview = await previewNextTag(app.repoFullName, bump);
      const messageId = await showRun(
        run,
        `⚠️ **${app.displayName}** 릴리즈 태그를 생성합니다.\n${preview.latest ?? "태그 없음"} → **${preview.next}**\nGitHub Release 생성까지 진행할까요?`,
        confirmationRows(run.id),
      );
      await prisma.operatorCommandRun.update({
        where: { id: run.id },
        data: {
          operation: "release_create",
          params: { bump, next: preview.next },
          status: "AWAITING_CONFIRMATION",
          attempts: 0,
          startedAt: null,
          messageId,
          expiresAt: new Date(Date.now() + CONFIRM_TTL_MS),
        },
      });
      return { summary: `릴리즈 ${preview.next} 확인 대기`, awaiting: true, messageId };
    }
    case "release_create": {
      const app = await appForRun(run);
      const result = await createReleaseTagWithNotes({
        repoFullName: app.repoFullName,
        tag: stringValue(params, "next"),
        actorLabel: run.actorLabel,
      });
      await showRun(run, `✅ **${app.displayName} ${result.tag}** 생성 완료\n[GitHub Release](${result.releaseUrl})`);
      return { summary: `릴리즈 ${result.tag} 생성` };
    }
    case "deploy": {
      const app = await appForRun(run);
      const target = stringValue(params, "target") as DeployTarget;
      const tag = stringValue(params, "tag");
      const result = await dispatchMarketDeploy({
        repoFullName: app.repoFullName,
        target,
        tag,
        actorLabel: run.actorLabel,
      });
      await showRun(
        run,
        `🚀 **${app.displayName} ${tag} → ${target}** 배포 트리거 완료` +
          (result.xcodeCloudBuild != null ? `\nXcode Cloud #${result.xcodeCloudBuild}` : ""),
      );
      return { summary: `${target} 배포 트리거` };
    }
    case "save": {
      const text = stringValue(params, "text");
      const title = text.split("\n")[0].trim().slice(0, 60) || "메모";
      await enqueueVaultWrite({
        folder: "받은함",
        title,
        content: text,
        source: "discord",
        requestedBy: run.actorDiscordUserId,
      });
      await showRun(run, `📥 받은함 저장 예약: **${title}**`);
      return { summary: `메모 저장: ${title}` };
    }
    case "index": {
      const result = await triggerVaultIndex();
      await showRun(run, `${result.triggered ? "🔄" : "⏳"} ${result.message} (${result.name})`);
      return { summary: result.message };
    }
    case "ask": {
      const reply = await handleDiscordChat({
        guildId: stringValue(params, "guildId"),
        channelId: run.channelId,
        userId: run.actorDiscordUserId,
        text: stringValue(params, "text"),
      });
      await showRun(run, `💬 <@${run.actorDiscordUserId}>\n${reply}`);
      return { summary: "AI 답변 생성" };
    }
    default:
      throw new Error(`지원하지 않는 작업: ${run.operation}`);
  }
}

export async function processNextOperatorCommand(): Promise<boolean> {
  const candidate = await prisma.operatorCommandRun.findFirst({
    where: { status: "PENDING", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return false;
  const claimed = await prisma.operatorCommandRun.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING", attempts: { increment: 1 }, startedAt: new Date() },
  });
  if (claimed.count !== 1) return true;
  const run = await prisma.operatorCommandRun.findUniqueOrThrow({ where: { id: candidate.id } });
  try {
    const result = await execute(run);
    if (!result.awaiting) {
      await prisma.operatorCommandRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED",
          summary: result.summary,
          messageId: result.messageId ?? run.messageId,
          params: Prisma.DbNull,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + RESULT_TTL_MS),
        },
      });
    }
  } catch (error) {
    const message = safeError(error);
    await showRun(run, `❌ 작업 실패: ${message}`);
    await prisma.operatorCommandRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        error: message,
        params: Prisma.DbNull,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + RESULT_TTL_MS),
      },
    });
  }
  return true;
}

export async function maintainOperatorCommands(now = new Date()) {
  const [expired, stale, redacted] = await prisma.$transaction([
    prisma.operatorCommandRun.updateMany({
      where: { status: "AWAITING_CONFIRMATION", expiresAt: { lte: now } },
      data: { status: "EXPIRED", params: Prisma.DbNull, completedAt: now },
    }),
    prisma.operatorCommandRun.updateMany({
      where: { status: "PROCESSING", startedAt: { lt: new Date(now.getTime() - STALE_MS) } },
      data: {
        status: "FAILED",
        error: "worker 중단으로 외부 적용 결과를 확인할 수 없습니다.",
        params: Prisma.DbNull,
        completedAt: now,
      },
    }),
    prisma.operatorCommandRun.updateMany({
      where: { redactedAt: null, expiresAt: { lte: now }, status: { in: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"] } },
      data: { params: Prisma.DbNull, summary: null, error: null, redactedAt: now },
    }),
  ]);
  return { expired: expired.count, stale: stale.count, redacted: redacted.count };
}

export function awaitingConfirmationText(operation: string): string {
  switch (operation) {
    case "deploy":
      return "배포 트리거";
    case "index":
      return "볼트 재인덱싱";
    default:
      return "작업";
  }
}

export function confirmationComponents(runId: string) {
  return confirmationRows(runId);
}
