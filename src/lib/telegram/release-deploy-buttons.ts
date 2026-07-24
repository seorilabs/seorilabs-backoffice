import type { InlineButton } from "@/lib/telegram/client";
import type { DeployTarget } from "@/lib/core/deploy-targets";

export type PlatformDeployTarget = Exclude<DeployTarget, "ALL">;
export type DeployButtonState =
  | "READY"
  | "TRIGGERING"
  | "TRIGGERED"
  | "IN_PROGRESS"
  | "SUCCEEDED"
  | "FAILED";
export type DeployButtonStates = Partial<Record<PlatformDeployTarget, DeployButtonState>>;

export interface DeployDispatchStateInput {
  target: DeployTarget;
  createdAt: Date;
}

export interface DeployRunStateInput {
  target: PlatformDeployTarget;
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "ROLLED_BACK";
  updatedAt: Date;
}

const TARGET_CODE: Record<PlatformDeployTarget, string> = {
  AIT: "a",
  PLAY: "p",
  APPSTORE: "s",
};

const CODE_TARGET: Record<string, PlatformDeployTarget> = {
  a: "AIT",
  p: "PLAY",
  s: "APPSTORE",
};

const STATE_CODE: Record<DeployButtonState, string> = {
  READY: "r",
  TRIGGERING: "g",
  TRIGGERED: "t",
  IN_PROGRESS: "i",
  SUCCEEDED: "s",
  FAILED: "f",
};

const BUTTON_PREFIX: Record<DeployButtonState, string> = {
  READY: "🚀",
  TRIGGERING: "⏳",
  TRIGGERED: "☑️",
  IN_PROGRESS: "⏳",
  SUCCEEDED: "✅",
  FAILED: "↻",
};

export function platformDeployTargets(targets: DeployTarget[]): PlatformDeployTarget[] {
  return targets.filter((target): target is PlatformDeployTarget => target !== "ALL");
}

export function deployTargetFromCode(code: string): PlatformDeployTarget | null {
  return CODE_TARGET[code] ?? null;
}

/**
 * dispatch 감사 로그와 workflow_run 미러 중 더 최신 신호로 버튼 상태를 계산한다.
 * Deploy All 감사 로그는 같은 시각의 모든 플랫폼 dispatch 로 취급한다.
 */
export function resolveDeployButtonStates(
  targets: PlatformDeployTarget[],
  dispatches: DeployDispatchStateInput[],
  runs: DeployRunStateInput[],
): DeployButtonStates {
  const states = Object.fromEntries(
    targets.map((target) => [target, "READY"]),
  ) as DeployButtonStates;

  for (const target of targets) {
    const latestDispatch = dispatches
      .filter((dispatch) => dispatch.target === target || dispatch.target === "ALL")
      .reduce<Date | null>(
        (latest, dispatch) =>
          latest == null || dispatch.createdAt > latest ? dispatch.createdAt : latest,
        null,
      );
    const latestRun = runs
      .filter((run) => run.target === target)
      .reduce<DeployRunStateInput | null>(
        (latest, run) => latest == null || run.updatedAt > latest.updatedAt ? run : latest,
        null,
      );

    if (latestDispatch && (!latestRun || latestDispatch > latestRun.updatedAt)) {
      states[target] = "TRIGGERED";
      continue;
    }
    if (!latestRun) continue;

    states[target] =
      latestRun.status === "PENDING"
        ? "TRIGGERED"
        : latestRun.status === "ROLLED_BACK"
          ? "FAILED"
          : latestRun.status;
  }

  return states;
}

export function buildReleaseDeployButtons(
  appId: string,
  tag: string,
  targets: PlatformDeployTarget[],
  states: DeployButtonStates,
  labels: Record<PlatformDeployTarget, string>,
): InlineButton[][] {
  const buttons = targets.map((target): InlineButton => {
    const state = states[target] ?? "READY";
    const actionable = state === "READY" || state === "FAILED";
    const action = actionable ? "dq" : "ds";
    return {
      text: `${BUTTON_PREFIX[state]} ${labels[target]}`,
      // Telegram callback_data 64-byte 제한을 위해 app slug 대신 cuid와 짧은 코드를 쓴다.
      callback_data: `${action}:${appId}:${tag}:${TARGET_CODE[target]}:${STATE_CODE[state]}`,
    };
  });

  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

/**
 * 업로드 이후 마켓 마무리 버튼(딥링크 확인 스텝 경유).
 * Google=프로덕션 승격(심사 제출), Apple=심사 준비 → 심사 제출.
 * callback_data 는 64바이트 제한을 위해 slug 대신 cuid(appId)를 쓴다.
 *   pp = play-promote, ap = appstore-prepare, as = appstore-submit
 */
export function buildMarketReviewButtons(
  appId: string,
  tag: string,
  targets: PlatformDeployTarget[],
): InlineButton[][] {
  const rows: InlineButton[][] = [];
  if (targets.includes("PLAY")) {
    rows.push([
      { text: "⬆️ Play 프로덕션 승격", callback_data: `pp:c:${appId}:${tag}` },
    ]);
  }
  if (targets.includes("APPSTORE")) {
    rows.push([
      { text: "📝 심사 준비", callback_data: `ap:${appId}:${tag}` },
      { text: "🚀 심사 제출", callback_data: `as:c:${appId}:${tag}` },
    ]);
  }
  return rows;
}

export function deployStateCallbackText(stateCode: string): string {
  switch (stateCode) {
    case "g":
      return "배포를 트리거하고 있습니다.";
    case "t":
      return "이미 배포를 요청했습니다.";
    case "i":
      return "배포가 진행 중입니다.";
    case "s":
      return "배포가 완료되었습니다.";
    case "f":
      return "이전 배포가 실패했습니다. 재시도할 수 있습니다.";
    default:
      return "배포 상태를 확인했습니다.";
  }
}
