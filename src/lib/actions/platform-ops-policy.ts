import { PlatformOperationInputError } from "@/lib/platform/operations";
import type { PlatformSandboxResetRemoteState } from "@/lib/platform/runs";

/**
 * 재개는 플랫폼에 durable intent가 남은 prepared 상태에서만 허용한다.
 * UI 분기와 무관하게 action 경계에서 검사해 종료 marker를 다시 실행하지 않는다.
 */
export async function resumePreparedSandboxResetWhenPrepared(
  remoteState: PlatformSandboxResetRemoteState,
  resume: () => Promise<void>,
): Promise<void> {
  if (remoteState !== "prepared") {
    switch (remoteState) {
      case "absent":
        throw new PlatformOperationInputError(
          "sandbox reset durable intent가 없습니다. 먼저 동일 request ID의 영구 미시작 종료를 등록하세요.",
        );
      case "completed":
        throw new PlatformOperationInputError(
          "sandbox reset이 이미 완료됐습니다. 플랫폼 적용 확인으로 대조 종료하세요.",
        );
      case "closed_not_started":
        throw new PlatformOperationInputError(
          "sandbox reset 미시작 종료가 이미 확정됐습니다. 플랫폼 미적용 확인으로 대조 종료하세요.",
        );
      default: {
        // 원격 상태가 추가되면 명시적 정책 없이 재개가 열리지 않게 컴파일 단계에서 막는다.
        const unsupportedState: never = remoteState;
        throw new PlatformOperationInputError(
          `지원하지 않는 sandbox reset 상태입니다: ${unsupportedState}`,
        );
      }
    }
  }

  await resume();
}
