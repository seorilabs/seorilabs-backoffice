import {
  PlatformOverviewStatus,
  type PlatformCapabilityView,
} from "@/components/platform";
import { loadPlatformIapSnapshotAction } from "@/lib/actions/platform-read";
import { env } from "@/lib/env";
import { platformReadConfiguration } from "@/lib/platform/read-client";

export const dynamic = "force-dynamic";

export default async function PlatformOverviewPage() {
  const configuration = platformReadConfiguration();
  const snapshot = configuration.configured
    ? await loadPlatformIapSnapshotAction()
    : null;
  const available = snapshot?.ok === true;
  const capabilities: PlatformCapabilityView[] = [
    {
      key: "auth",
      label: "공통 인증",
      state: available ? "available" : "unavailable",
      description: "플랫폼 사용자 ID·지원 코드 기반 PII 없는 사용자 조회",
    },
    {
      key: "iap-read",
      label: "IAP 원장 조회",
      state: available ? "available" : "unavailable",
      description: "최근 주문, entitlement source, 운영자 변경 이력 조회",
    },
    {
      key: "iap-write",
      label: "IAP 운영자 변경",
      state:
        available && env.featurePlatformWrites() ? "partial" : "unavailable",
      description: env.featurePlatformWrites()
        ? "별도 write identity를 가진 AppOps worker를 통해서만 실행"
        : "registry·catalog·worker 준비 뒤 별도 write 전환 플래그로 활성화",
    },
  ];

  const message = !configuration.configured
    ? configuration.message
    : snapshot && !snapshot.ok
      ? snapshot.error
      : snapshot?.data.health.environmentMismatches.length
        ? "레지스트리와 원장 환경이 어긋나 일부 앱의 운영 조작이 막혀 있습니다."
        : snapshot?.data.health.deadLetterCount
          ? "IAP dead-letter가 있어 완료 처리 상태 확인이 필요합니다."
          : "조회 전용 연결과 플랫폼 운영 상태를 확인했습니다.";

  return (
    <PlatformOverviewStatus
      connection={
        !configuration.configured
          ? "unconfigured"
          : !snapshot?.ok
            ? "unavailable"
            : snapshot.data.health.deadLetterCount > 0 ||
                snapshot.data.health.environmentMismatches.length > 0
              ? "degraded"
              : "connected"
      }
      environment={snapshot?.ok ? snapshot.data.health.environment : null}
      deadLetterCount={snapshot?.ok ? snapshot.data.health.deadLetterCount : null}
      environmentMismatches={
        snapshot?.ok ? snapshot.data.health.environmentMismatches : []
      }
      capabilities={capabilities}
      lastCheckedAt={snapshot?.ok ? snapshot.data.checkedAt : null}
      message={message}
    />
  );
}
