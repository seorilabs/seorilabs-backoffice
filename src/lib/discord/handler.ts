import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { resetDiscordChat } from "@/lib/discord/chat";
import {
  awaitingConfirmationText,
  cancelOperatorCommand,
  confirmOperatorCommand,
  confirmationComponents,
  createOperatorCommand,
} from "@/lib/discord/command-runs";
import {
  approvalsQuery,
  autocompleteApps,
  findVisibleApp,
  metricsQuery,
  p1Query,
  statusQuery,
} from "@/lib/discord/queries";
import { capabilityForCommand, hasDiscordCapability, isDiscordInteractionScope, type DiscordCapability } from "@/lib/discord/roles";
import { ephemeral, modal } from "@/lib/discord/responses";
import {
  EPHEMERAL_FLAG,
  InteractionResponseType,
  InteractionType,
  type DiscordInteraction,
  type DiscordInteractionOption,
} from "@/lib/discord/types";

const TAG_RE = /^v\d+\.\d+\.\d+$/;
const BUMPS = new Set(["patch", "minor", "major"]);
const TARGETS = new Set(["AIT", "PLAY", "APPSTORE", "ALL"]);

function option(options: DiscordInteractionOption[] | undefined, name: string): string {
  const value = options?.find((item) => item.name === name)?.value;
  return typeof value === "string" ? value : "";
}

function modalText(interaction: DiscordInteraction): string {
  for (const row of interaction.data?.components ?? []) {
    for (const item of row.components ?? []) {
      if (item.custom_id === "text" && typeof item.value === "string") return item.value.trim();
    }
  }
  return "";
}

function response(content: string, components: unknown[] = [], ephemeralMessage = false) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE,
    data: {
      content: content.slice(0, 2_000),
      ...(components.length ? { components } : {}),
      ...(ephemeralMessage ? { flags: EPHEMERAL_FLAG } : {}),
      allowed_mentions: { parse: [] },
    },
  };
}

function update(content: string) {
  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: { content: content.slice(0, 2_000), components: [], allowed_mentions: { parse: [] } },
  };
}

function roles(interaction: DiscordInteraction): string[] {
  return interaction.member?.roles ?? [];
}

function actor(interaction: DiscordInteraction): string {
  return interaction.member?.user?.id ?? "";
}

function authorized(interaction: DiscordInteraction, capability: DiscordCapability): boolean {
  return !!actor(interaction) && hasDiscordCapability(roles(interaction), capability);
}

function commandCapability(operation: string): DiscordCapability {
  if (operation === "approval") return "planning_approval";
  if (operation === "incident_ack" || operation === "incident_assign") return "ops_incident";
  if (operation === "release_create" || operation === "release_preview" || operation === "deploy") return "release";
  if (operation === "index") return "vault_index";
  if (operation === "save") return "vault_write";
  if (operation === "plan_generate" || operation === "draft_commit") return "planning";
  if (operation === "bug_generate") return "bug";
  return "read";
}

function helpText(): string {
  return [
    "**Seorilabs Backoffice Bot**",
    "조회: `/approvals` `/p1` `/status [app]` `/metrics [app]`",
    "초안: `/plan app` `/bug app` — AI 초안 확인 후 버튼으로 GitHub 이슈 생성",
    "릴리즈: `/release app bump` `/deploy app tag target` — 실행 전 확인 버튼 필요",
    "볼트/대화: `/save` `/index` `/ask` `/reset`",
    "쓰기 권한은 Discord 업무 역할로 제한되며 실행자는 감사 로그에 남습니다.",
    "https://backoffice.vzyx.xyz",
  ].join("\n");
}

async function handleApplicationCommand(interaction: DiscordInteraction) {
  const name = interaction.data?.name ?? "";
  if (!authorized(interaction, capabilityForCommand(name))) return ephemeral("이 명령을 실행할 역할 권한이 없습니다.");
  const appSlug = option(interaction.data?.options, "app");
  const channelId = interaction.channel_id ?? "";
  const userId = actor(interaction);

  if (name === "help") return ephemeral(helpText());
  if (name === "approvals") {
    const result = await approvalsQuery();
    return response(result.content, result.components);
  }
  if (name === "p1") return response((await p1Query()).content);
  if (name === "status") return response((await statusQuery(appSlug || undefined)).content);
  if (name === "metrics") return response((await metricsQuery(appSlug || undefined)).content);
  if (name === "reset") {
    await resetDiscordChat({ guildId: interaction.guild_id!, channelId, userId });
    return ephemeral("🧹 내 대화 문맥을 초기화했습니다.");
  }

  if (name === "plan" || name === "bug") {
    const app = await findVisibleApp(appSlug);
    if (!app) return ephemeral("앱을 찾을 수 없습니다.");
    return modal(
      `modal:${name}:${app.id}`,
      name === "plan" ? `${app.displayName} 기획` : `${app.displayName} 버그`,
      name === "plan" ? "핵심 아이디어" : "증상과 재현 방법",
    );
  }
  if (name === "save") return modal("modal:save:none", "Obsidian 받은함", "저장할 메모");
  if (name === "ask") return modal("modal:ask:none", "백오피스 AI", "질문");

  if (name === "release") {
    const app = await findVisibleApp(appSlug);
    const bump = option(interaction.data?.options, "bump");
    if (!app || !BUMPS.has(bump)) return ephemeral("앱 또는 버전 증가 값이 올바르지 않습니다.");
    await createOperatorCommand({
      sourceInteractionId: interaction.id,
      appId: app.id,
      operation: "release_preview",
      params: { bump },
      actorDiscordUserId: userId,
      channelId,
    });
    return ephemeral("⏳ 현재 태그를 확인한 뒤 이 채널에 최종 확인 버튼을 표시합니다.");
  }

  if (name === "deploy") {
    const app = await findVisibleApp(appSlug);
    const tag = option(interaction.data?.options, "tag");
    const target = option(interaction.data?.options, "target");
    if (!app || !TAG_RE.test(tag) || !TARGETS.has(target)) return ephemeral("앱, 태그 또는 배포 대상이 올바르지 않습니다.");
    const run = await createOperatorCommand({
      sourceInteractionId: interaction.id,
      appId: app.id,
      operation: "deploy",
      params: { tag, target },
      actorDiscordUserId: userId,
      channelId,
      needsConfirmation: true,
    });
    return response(
      `⚠️ **${app.displayName} ${tag} → ${target}** 배포 워크플로를 트리거할까요?\n실행자 <@${userId}> · 10분 후 만료`,
      confirmationComponents(run.id),
    );
  }

  if (name === "index") {
    const run = await createOperatorCommand({
      sourceInteractionId: interaction.id,
      operation: "index",
      actorDiscordUserId: userId,
      channelId,
      needsConfirmation: true,
    });
    return response(`⚠️ Obsidian 볼트 재인덱싱을 실행할까요?\n실행자 <@${userId}> · 10분 후 만료`, confirmationComponents(run.id));
  }
  return ephemeral("지원하지 않는 명령입니다.");
}

async function handleModal(interaction: DiscordInteraction) {
  const [prefix, action, appId] = (interaction.data?.custom_id ?? "").split(":");
  const text = modalText(interaction);
  if (prefix !== "modal" || !text || text.length > 4_000) return ephemeral("입력값이 올바르지 않습니다.");
  const capability = action === "plan" ? "planning" : action === "bug" ? "bug" : action === "save" ? "vault_write" : "read";
  if (!authorized(interaction, capability)) return ephemeral("이 작업을 실행할 역할 권한이 없습니다.");
  if (!new Set(["plan", "bug", "save", "ask"]).has(action)) return ephemeral("지원하지 않는 입력입니다.");
  if ((action === "plan" || action === "bug") && !appId) return ephemeral("앱이 지정되지 않았습니다.");
  await createOperatorCommand({
    sourceInteractionId: interaction.id,
    ...(action === "plan" || action === "bug" ? { appId } : {}),
    operation: action === "plan" ? "plan_generate" : action === "bug" ? "bug_generate" : action,
    params: action === "ask" ? { text, guildId: interaction.guild_id! } : { text },
    actorDiscordUserId: actor(interaction),
    channelId: interaction.channel_id!,
  });
  return ephemeral(action === "ask" ? "⏳ 답변을 준비합니다." : "⏳ 작업을 큐에 등록했습니다.");
}

async function handleComponent(interaction: DiscordInteraction) {
  const [kind, action, id] = (interaction.data?.custom_id ?? "").split(":");
  const userId = actor(interaction);
  const channelId = interaction.channel_id ?? "";
  const messageId = interaction.message?.id;

  if (kind === "command") {
    const run = await prisma.operatorCommandRun.findUnique({ where: { id }, select: { operation: true, actorDiscordUserId: true } });
    if (!run || run.actorDiscordUserId !== userId) return ephemeral("이 확인은 명령을 요청한 사용자만 처리할 수 있습니다.");
    if (!authorized(interaction, commandCapability(run.operation))) return ephemeral("이 작업을 실행할 역할 권한이 없습니다.");
    if (action === "confirm") {
      const changed = await confirmOperatorCommand({ id, actorDiscordUserId: userId, channelId, messageId });
      return changed ? update(`⏳ ${awaitingConfirmationText(run.operation)} 실행 중…`) : ephemeral("이미 처리됐거나 확인 시간이 만료됐습니다.");
    }
    if (action === "cancel") {
      const changed = await cancelOperatorCommand({ id, actorDiscordUserId: userId });
      return changed ? update("✖️ 작업을 취소했습니다.") : ephemeral("이미 처리됐거나 취소할 수 없습니다.");
    }
  }

  if (kind === "draft") {
    if (action === "commit") {
      if (!authorized(interaction, "planning") && !authorized(interaction, "bug")) return ephemeral("이슈 생성 권한이 없습니다.");
      await createOperatorCommand({
        sourceInteractionId: interaction.id,
        operation: "draft_commit",
        params: { draftId: id },
        actorDiscordUserId: userId,
        channelId,
        messageId,
      });
      return update("⏳ GitHub 이슈를 생성 중…");
    }
    if (action === "cancel") {
      const draft = await prisma.aiDraft.findUnique({ where: { id }, select: { status: true, createdBy: true } });
      if (!draft || draft.createdBy !== `discord:${userId}`) return ephemeral("본인이 만든 초안만 취소할 수 있습니다.");
      if (draft.status === "DRAFT") await prisma.aiDraft.update({ where: { id }, data: { status: "DISCARDED" } });
      return update("✖️ 초안을 취소했습니다.");
    }
  }

  if (kind === "approval") {
    const gate = action;
    if (gate !== "planning" && gate !== "release") return ephemeral("잘못된 승인 요청입니다.");
    const capability = gate === "planning" ? "planning_approval" : "release_approval";
    if (!authorized(interaction, capability)) return ephemeral("이 승인 권한이 없습니다.");
    await createOperatorCommand({
      sourceInteractionId: interaction.id,
      operation: "approval",
      params: { gate, issueId: id },
      actorDiscordUserId: userId,
      channelId,
      messageId,
    });
    return update("⏳ 승인을 반영 중…");
  }
  if (kind === "generate") {
    if (!authorized(interaction, "planning")) return ephemeral("초안 생성 권한이 없습니다.");
    const draftKind = action;
    if (!new Set(["TASK_BREAKDOWN", "QA_CHECKLIST", "RELEASE_NOTES", "STORE_COPY", "IMPROVEMENT_HYPOTHESIS"]).has(draftKind)) {
      return ephemeral("지원하지 않는 초안 종류입니다.");
    }
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true } });
    if (!app) return ephemeral("앱을 찾을 수 없습니다.");
    await createOperatorCommand({
      sourceInteractionId: interaction.id,
      appId: app.id,
      operation: "stage_generate",
      params: { kind: draftKind },
      actorDiscordUserId: userId,
      channelId,
      messageId,
    });
    return update("⏳ 단계 초안을 생성 중…");
  }
  if (kind === "incident") {
    if (!authorized(interaction, "ops_incident")) return ephemeral("장애 대응 권한이 없습니다.");
    if (action !== "ack" && action !== "assign") return ephemeral("지원하지 않는 장애 작업입니다.");
    const incident = await prisma.operationalIncident.findUnique({ where: { id }, select: { id: true } });
    if (!incident) return ephemeral("장애를 찾을 수 없습니다.");
    await createOperatorCommand({
      sourceInteractionId: interaction.id,
      operation: action === "assign" ? "incident_assign" : "incident_ack",
      params: { incidentId: id },
      actorDiscordUserId: userId,
      channelId,
      messageId,
    });
    return update(action === "assign" ? "⏳ 담당자를 지정 중…" : "⏳ 장애 확인을 반영 중…");
  }
  return ephemeral("지원하지 않는 버튼입니다.");
}

export async function handleDiscordInteraction(interaction: DiscordInteraction) {
  if (interaction.type === InteractionType.PING) return { type: InteractionResponseType.PONG };
  if (!isDiscordInteractionScope({
    guildId: interaction.guild_id,
    channelId: interaction.channel_id,
    expectedGuildId: env.discordGuildId(),
    expectedChannelId: env.discordChannelId("backoffice"),
  })) return ephemeral("백오피스 명령은 허용된 Discord 서버의 #backoffice 채널에서만 사용할 수 있습니다.");

  if (interaction.type === InteractionType.AUTOCOMPLETE) {
    if (!authorized(interaction, "read")) return { type: InteractionResponseType.AUTOCOMPLETE_RESULT, data: { choices: [] } };
    const focused = interaction.data?.options?.find((item) => item.focused);
    return {
      type: InteractionResponseType.AUTOCOMPLETE_RESULT,
      data: { choices: await autocompleteApps(typeof focused?.value === "string" ? focused.value : "") },
    };
  }
  if (interaction.type === InteractionType.APPLICATION_COMMAND) return handleApplicationCommand(interaction);
  if (interaction.type === InteractionType.MODAL_SUBMIT) return handleModal(interaction);
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) return handleComponent(interaction);
  return ephemeral("지원하지 않는 Discord 요청입니다.");
}
