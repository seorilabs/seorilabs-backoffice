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
import {
  capabilityForCommand,
  hasDiscordCapability,
  isDiscordInteractionScope,
  interactionChannelKeys,
  type DiscordCapability,
} from "@/lib/discord/roles";
import { skipTeammateFinding } from "@/lib/discord/teammate-findings";
import { DEPLOY_CARD_ACTION_KO, DEPLOY_CARD_ACTIONS, type DeployCardAction } from "@/lib/notifications/deploy-format";
import { requiresOperatorConfirmation } from "@/lib/discord/command-policy";
import { asStringArray } from "@/lib/format";
import type { DiscordActionRow } from "@/lib/notifications/discord";
import { deferredUpdate, ephemeral, modal, updateMessage } from "@/lib/discord/responses";
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

/**
 * 배포 카드 액션의 확인은 ephemeral 로 띄운다. 카드 메시지는 worker 가 단독으로 소유해야
 * 실행 결과 렌더와 interaction 응답이 같은 메시지를 두고 경합하지 않는다.
 */
function ephemeralConfirmRows(runId: string): DiscordActionRow[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 4, label: "실행", custom_id: `command:econfirm:${runId}` },
      { type: 2, style: 2, label: "취소", custom_id: `command:ecancel:${runId}` },
    ],
  }];
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
  if (operation.startsWith("release_") || operation === "deploy") return "release";
  if (operation.startsWith("develop_")) return "release";
  if (operation === "play_promote" || operation.startsWith("appstore_")) return "release";
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
    "후보 배포: `/develop app` — develop HEAD를 후보 태그로 등록된 내부 테스트 채널에 빌드·배포",
    "태그 카드에서 배포할 마켓을 버튼으로 고를 수 있습니다.",
    "배포 카드에서 Play 프로덕션 승격, App Store 심사 생성·제출·삭제·제출 취소를 버튼으로 실행합니다.",
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

  if (name === "develop") {
    const app = await findVisibleApp(appSlug);
    if (!app) return ephemeral("앱을 찾을 수 없습니다.");
    const testTargets = new Set(asStringArray(app.marketTargets));
    if (!["ait", "play", "appstore"].every((target) => testTargets.has(target))) {
      return ephemeral(
        "AppsInToss·Google Play 내부 테스트·TestFlight가 모두 등록된 앱만 develop 후보 배포를 실행할 수 있습니다.",
      );
    }
    await createOperatorCommand({
      sourceInteractionId: interaction.id,
      appId: app.id,
      operation: "develop_preview",
      actorDiscordUserId: userId,
      channelId,
    });
    return ephemeral("⏳ develop HEAD와 다음 후보 태그를 확인합니다.");
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
  const parts = (interaction.data?.custom_id ?? "").split(":");
  const [kind, action, id] = parts;
  const userId = actor(interaction);
  const channelId = interaction.channel_id ?? "";
  const messageId = interaction.message?.id;

  if (kind === "command") {
    const run = await prisma.operatorCommandRun.findUnique({ where: { id }, select: { operation: true, actorDiscordUserId: true } });
    if (!run || run.actorDiscordUserId !== userId) return ephemeral("이 확인은 명령을 요청한 사용자만 처리할 수 있습니다.");
    if (!authorized(interaction, commandCapability(run.operation))) return ephemeral("이 작업을 실행할 역할 권한이 없습니다.");
    if (action === "confirm") {
      const changed = await confirmOperatorCommand({ id, actorDiscordUserId: userId, channelId, messageId });
      return changed ? updateMessage(`⏳ ${awaitingConfirmationText(run.operation)} 실행 중…`) : ephemeral("이미 처리됐거나 확인 시간이 만료됐습니다.");
    }
    if (action === "cancel") {
      const changed = await cancelOperatorCommand({ id, actorDiscordUserId: userId });
      return changed ? updateMessage("✖️ 작업을 취소했습니다.") : ephemeral("이미 처리됐거나 취소할 수 없습니다.");
    }
    // ephemeral 확인창은 route 가 interaction 응답 직후 삭제한다. worker 에는 ephemeral
    // messageId 를 넘기지 않아 완료 결과만 채널 메시지나 원래 배포 카드에 남긴다.
    if (action === "econfirm") {
      const changed = await confirmOperatorCommand({ id, actorDiscordUserId: userId, channelId });
      return changed
        ? deferredUpdate()
        : ephemeral("이미 처리됐거나 확인 시간이 만료됐습니다.");
    }
    if (action === "ecancel") {
      const changed = await cancelOperatorCommand({ id, actorDiscordUserId: userId });
      return changed ? deferredUpdate() : ephemeral("이미 처리됐거나 취소할 수 없습니다.");
    }
  }

  // 릴리즈 태그 카드의 마켓 배포 버튼 — rdeploy:<target>:<appId>:<tag>
  if (kind === "rdeploy") {
    if (!authorized(interaction, "release")) return ephemeral("배포 권한이 없습니다.");
    const [, target, appId, tag] = parts;
    if (!appId || !TARGETS.has(target) || !TAG_RE.test(tag ?? "")) {
      return ephemeral("앱, 배포 대상 또는 태그가 올바르지 않습니다.");
    }
    const app = await prisma.app.findUnique({ where: { id: appId }, select: { id: true, displayName: true } });
    if (!app) return ephemeral("앱을 찾을 수 없습니다.");
    const run = await createOperatorCommand({
      sourceInteractionId: interaction.id,
      appId: app.id,
      operation: "deploy",
      params: { tag, target },
      actorDiscordUserId: userId,
      channelId,
      needsConfirmation: true,
    });
    return ephemeral(
      `⚠️ **${app.displayName} ${tag} → ${target}** 배포 워크플로를 트리거할까요? · 10분 후 만료`,
      ephemeralConfirmRows(run.id),
    );
  }

  // 배포 카드의 마켓 후속 작업 버튼 — deploycard:<action>:<releaseRecordId>
  if (kind === "deploycard") {
    if (!authorized(interaction, "release")) return ephemeral("배포 권한이 없습니다.");
    if (!DEPLOY_CARD_ACTIONS.includes(action as DeployCardAction)) {
      return ephemeral("지원하지 않는 배포 작업입니다.");
    }
    const cardAction = action as DeployCardAction;
    if (!id) return ephemeral("배포 기록이 지정되지 않았습니다.");
    const release = await prisma.releaseRecord.findUnique({
      where: { id },
      select: { id: true, appId: true, version: true, app: { select: { displayName: true } } },
    });
    if (!release) return ephemeral("배포 기록을 찾을 수 없습니다.");
    if (!TAG_RE.test(release.version)) return ephemeral("태그 없는 배포에는 후속 작업을 할 수 없습니다.");

    const needsConfirmation = requiresOperatorConfirmation(cardAction);
    const run = await createOperatorCommand({
      sourceInteractionId: interaction.id,
      appId: release.appId,
      operation: cardAction,
      params: { releaseRecordId: release.id, tag: release.version },
      actorDiscordUserId: userId,
      channelId,
      messageId,
      needsConfirmation,
    });
    const label = DEPLOY_CARD_ACTION_KO[cardAction];
    return needsConfirmation
      ? ephemeral(
          `⚠️ **${release.app.displayName} ${release.version}** ${label}을(를) 실행할까요? · 10분 후 만료`,
          ephemeralConfirmRows(run.id),
        )
      : deferredUpdate();
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
      return updateMessage("⏳ GitHub 이슈를 생성 중…");
    }
    if (action === "cancel") {
      const draft = await prisma.aiDraft.findUnique({ where: { id }, select: { status: true, createdBy: true } });
      if (!draft || draft.createdBy !== `discord:${userId}`) return ephemeral("본인이 만든 초안만 취소할 수 있습니다.");
      if (draft.status === "DRAFT") await prisma.aiDraft.update({ where: { id }, data: { status: "DISCARDED" } });
      return updateMessage("✖️ 초안을 취소했습니다.");
    }
  }

  // AI 팀원 순찰 초안 카드 — teammate:<confirm|cancel>:<runId>:<findingIndex>
  if (kind === "teammate") {
    if (!authorized(interaction, "planning") && !authorized(interaction, "bug")) {
      return ephemeral("이슈 등록 권한이 없습니다.");
    }
    const findingIndex = Number(parts[3]);
    if (!id || !Number.isInteger(findingIndex) || findingIndex < 0) {
      return ephemeral("잘못된 초안 요청입니다.");
    }
    const patrolRun = await prisma.teammateRun.findUnique({ where: { id }, select: { id: true } });
    if (!patrolRun) return ephemeral("순찰 기록을 찾을 수 없습니다.");
    if (action === "confirm") {
      await createOperatorCommand({
        sourceInteractionId: interaction.id,
        operation: "teammate_issue_create",
        params: { runId: id, findingIndex },
        actorDiscordUserId: userId,
        channelId,
        messageId,
      });
      return updateMessage("⏳ GitHub 이슈를 생성 중…");
    }
    if (action === "cancel") {
      const skipped = await skipTeammateFinding(id, findingIndex);
      return skipped ? updateMessage("✖️ 초안을 폐기했습니다.") : ephemeral("이미 처리된 초안입니다.");
    }
    return ephemeral("지원하지 않는 초안 작업입니다.");
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
    return updateMessage("⏳ 승인을 반영 중…");
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
    return updateMessage("⏳ 단계 초안을 생성 중…");
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
    return updateMessage(action === "assign" ? "⏳ 담당자를 지정 중…" : "⏳ 장애 확인을 반영 중…");
  }
  return ephemeral("지원하지 않는 버튼입니다.");
}

export async function handleDiscordInteraction(interaction: DiscordInteraction) {
  if (interaction.type === InteractionType.PING) return { type: InteractionResponseType.PONG };
  // 버튼은 카드가 놓인 채널에서 눌린다. 명령을 #backoffice 로 묶은 채로 버튼까지 묶으면
  // release-ops 의 배포 카드나 ops-alerts 의 장애 카드가 눌리지 않는다.
  const isComponent = interaction.type === InteractionType.MESSAGE_COMPONENT;
  const allowedChannelIds = interactionChannelKeys(isComponent).map((key) =>
    env.discordChannelId(key),
  );
  if (!isDiscordInteractionScope({
    guildId: interaction.guild_id,
    channelId: interaction.channel_id,
    expectedGuildId: env.discordGuildId(),
    allowedChannelIds,
  })) {
    return ephemeral(
      isComponent
        ? "이 버튼은 허용된 Discord 서버의 운영 채널에서만 사용할 수 있습니다."
        : "백오피스 명령은 허용된 Discord 서버의 #backoffice 채널에서만 사용할 수 있습니다.",
    );
  }

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
