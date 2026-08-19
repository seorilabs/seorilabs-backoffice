import { deployTargetsFor, DEPLOY_TARGET_KO, type DeployTarget } from "@/lib/core/deploy-targets";
import type { DiscordActionRow } from "@/lib/notifications/discord";

/**
 * 릴리즈 태그 카드에서 바로 고를 수 있는 마켓 배포 버튼.
 * 앱이 실제로 내보내는 마켓만 노출한다(deployTargetsFor 는 대상이 2개 이상일 때만 ALL 추가).
 */
export function releaseDeployRows(
  appId: string,
  tag: string,
  marketTargets: unknown,
): DiscordActionRow[] {
  const targets = deployTargetsFor(marketTargets);
  if (targets.length === 0) return [];
  return [{
    type: 1,
    components: targets.map((target) => ({
      type: 2 as const,
      style: (target === "ALL" ? 4 : 1) as 1 | 4,
      label: DEPLOY_TARGET_KO[target],
      custom_id: releaseDeployCustomId(appId, tag, target),
    })),
  }];
}

/**
 * handler 는 이 id 를 ":" 로 분해해 target·appId·tag 를 읽는다. target 을 DeployTarget 으로
 * 제한해 구분자가 섞이거나 없는 대상이 들어가는 경로를 타입에서 막는다.
 */
export function releaseDeployCustomId(appId: string, tag: string, target: DeployTarget): string {
  return `rdeploy:${target}:${appId}:${tag}`;
}
