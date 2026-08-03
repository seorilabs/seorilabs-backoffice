import {
  PlatformOverviewStatus,
  type PlatformCapabilityView,
} from "@/components/platform";
import {
  overviewConnectionState,
  overviewMessage,
} from "@/components/platform/presentation";
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

  const health = snapshot?.ok ? snapshot.data.health : null;
  const mismatches = health?.environmentMismatches ?? [];

  const message = overviewMessage({
    configuredMessage: configuration.configured ? null : configuration.message,
    errorMessage: snapshot && !snapshot.ok ? snapshot.error : null,
    deadLetterCount: health?.deadLetterCount ?? 0,
    environmentMismatchCount: mismatches.length,
  });

  return (
    <PlatformOverviewStatus
      connection={overviewConnectionState({
        configured: configuration.configured,
        reachable: snapshot?.ok === true,
        deadLetterCount: health?.deadLetterCount ?? 0,
        environmentMismatchCount: mismatches.length,
      })}
      environment={snapshot?.ok ? snapshot.data.health.environment : null}
      deadLetterCount={snapshot?.ok ? snapshot.data.health.deadLetterCount : null}
      environmentMismatches={mismatches}
      capabilities={capabilities}
      lastCheckedAt={snapshot?.ok ? snapshot.data.checkedAt : null}
      message={message}
    />
  );
}
