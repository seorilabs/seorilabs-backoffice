import { env } from "@/lib/env";
import { PlatformClient } from "@/lib/platform/client";

import type { PlatformOperationsClientFactory } from "./executor";

/**
 * 실제 PlatformClient와 worker executor 사이의 유일한 조립 지점이다.
 * 웹 Pod의 read SA가 아니라 worker 전용 write SA만 사용한다.
 */
export const createPlatformWriteOperationsClient: PlatformOperationsClientFactory =
  () => {
    if (!env.platformWriteConfigured()) {
      throw new Error("플랫폼 Admin API write 설정이 없습니다.");
    }
    return new PlatformClient({
      baseUrl: env.platformAdminUrl(),
      serviceAccountJson: env.platformAdminWriteSaKeyJson(),
    });
  };
