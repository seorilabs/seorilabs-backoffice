import { prisma } from "@/lib/prisma";
import {
  DEPLOY_TARGET_KO,
  deployTargetsFor,
} from "@/lib/core/deploy-targets";
import {
  buildMarketReviewButtons,
  buildReleaseDeployButtons,
  platformDeployTargets,
  resolveDeployButtonStates,
  type DeployButtonStates,
  type DeployDispatchStateInput,
  type DeployRunStateInput,
  type PlatformDeployTarget,
} from "@/lib/telegram/release-deploy-buttons";
import {
  editMessageText,
  esc,
  telegramResponseOk,
} from "@/lib/telegram/client";
import { deployTargetFromAuditPayload } from "@/lib/telegram/release-message-payload";

export interface ReleaseDeployApp {
  id: string;
  slug: string;
  displayName: string;
  repoFullName: string;
  marketTargets: unknown;
}

export async function loadReleaseDeployStates(
  app: ReleaseDeployApp,
  tag: string,
  targets: PlatformDeployTarget[],
): Promise<DeployButtonStates> {
  const [auditRows, releaseRows] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        action: "release.deploy.dispatch",
        entityType: "release",
        entityId: `${app.repoFullName}@${tag}`,
      },
      select: { payload: true, createdAt: true },
    }),
    prisma.releaseRecord.findMany({
      where: { appId: app.id, version: tag, market: { in: targets } },
      select: { market: true, status: true, updatedAt: true },
    }),
  ]);

  const dispatches = auditRows.flatMap((row): DeployDispatchStateInput[] => {
    const target = deployTargetFromAuditPayload(row.payload);
    return target ? [{ target, createdAt: row.createdAt }] : [];
  });
  const runs = releaseRows.map(
    (row): DeployRunStateInput => ({
      target: row.market as PlatformDeployTarget,
      status: row.status,
      updatedAt: row.updatedAt,
    }),
  );
  return resolveDeployButtonStates(targets, dispatches, runs);
}

export function releaseDeployMessage(opts: {
  app: ReleaseDeployApp;
  tag: string;
  releaseUrl?: string;
  created?: boolean;
  note?: string;
}): string {
  const targets = platformDeployTargets(deployTargetsFor(opts.app.marketTargets));
  const releaseUrl =
    opts.releaseUrl ??
    `https://github.com/${opts.app.repoFullName}/releases/tag/${encodeURIComponent(opts.tag)}`;
  const lines = [
    `✅ <b>${esc(opts.app.displayName)} ${esc(opts.tag)}</b> 릴리즈 생성됨${opts.created === false ? " (기존 태그 재사용)" : ""}`,
    esc(releaseUrl),
    "출시노트 번역은 백그라운드에서 생성 중입니다.",
  ];
  if (targets.length > 0) {
    lines.push("", "<b>📦 플랫폼별 배포</b>", "각 버튼은 독립적으로 트리거됩니다.");
  } else {
    lines.push("", "배포 가능한 플랫폼 워크플로우가 설정되어 있지 않습니다.");
  }
  if (opts.note) lines.push("", opts.note);
  return lines.join("\n");
}

export async function editReleaseDeployMessage(opts: {
  chatId: string | number;
  messageId: number;
  app: ReleaseDeployApp;
  tag: string;
  states: DeployButtonStates;
  releaseUrl?: string;
  created?: boolean;
  note?: string;
}): Promise<boolean> {
  const targets = platformDeployTargets(deployTargetsFor(opts.app.marketTargets));
  const response = await editMessageText(
    opts.chatId,
    opts.messageId,
    releaseDeployMessage(opts),
    [
      ...buildReleaseDeployButtons(opts.app.id, opts.tag, targets, opts.states, DEPLOY_TARGET_KO),
      ...buildMarketReviewButtons(opts.app.id, opts.tag, targets),
    ],
  );
  return telegramResponseOk(response);
}

/** appId+tag 로 릴리즈 배포 메시지(버튼 포함)를 현재 미러 상태로 재구성한다. */
export async function rebuildReleaseDeployMessage(
  chatId: string | number,
  messageId: number,
  app: ReleaseDeployApp,
  tag: string,
  note?: string,
): Promise<boolean> {
  const targets = platformDeployTargets(deployTargetsFor(app.marketTargets));
  const states = await loadReleaseDeployStates(app, tag, targets);
  return editReleaseDeployMessage({ chatId, messageId, app, tag, states, note });
}
