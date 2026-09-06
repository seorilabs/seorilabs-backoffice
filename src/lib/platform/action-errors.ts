import { PlatformAccessError } from "@/lib/platform/access";
import { PlatformOperationInputError } from "@/lib/platform/operations";

/**
 * 내부 오류 문구를 밖으로 흘리지 않는다. 사용자 입력 오류만 그대로 준다.
 *
 * "use server" 모듈은 async 함수만 export할 수 있어 서버 액션 파일에 둘 수 없다.
 */
export function publicActionError(error: unknown, fallback: string): string {
  if (
    error instanceof PlatformAccessError ||
    error instanceof PlatformOperationInputError
  ) {
    return error.message;
  }
  return fallback;
}
