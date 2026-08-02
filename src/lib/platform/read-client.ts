import { env } from "@/lib/env";
import { PlatformClient } from "@/lib/platform/client";

export interface PlatformReadConfiguration {
  enabled: boolean;
  configured: boolean;
  message: string;
}

/**
 * 플랫폼 조회 연결 상태를 비밀값 없이 설명한다.
 *
 * URL이나 서비스 계정 내용은 UI에 내보내지 않는다. 운영 화면에는
 * 기능 사용 가능 여부만 필요하고, 실제 값은 Secret에만 있어야 한다.
 */
export function platformReadConfiguration(): PlatformReadConfiguration {
  if (!env.featurePlatform()) {
    return {
      enabled: false,
      configured: false,
      message: "플랫폼 관리 기능이 비활성화되어 있습니다.",
    };
  }
  if (!env.platformAdminUrl().trim()) {
    return {
      enabled: true,
      configured: false,
      message: "플랫폼 Admin API 주소가 설정되지 않았습니다.",
    };
  }
  if (!env.platformAdminReadSaKeyJson().trim()) {
    return {
      enabled: true,
      configured: false,
      message: "플랫폼 조회 전용 identity가 설정되지 않았습니다.",
    };
  }
  return {
    enabled: true,
    configured: true,
    message: "플랫폼 조회 전용 연결이 준비되었습니다.",
  };
}

/** 웹 Pod에서 쓸 read-only 플랫폼 클라이언트를 만든다. */
export function createPlatformReadClient(): PlatformClient {
  const state = platformReadConfiguration();
  if (!state.configured) throw new Error(state.message);

  return new PlatformClient({
    baseUrl: env.platformAdminUrl(),
    serviceAccountJson: env.platformAdminReadSaKeyJson(),
  });
}
