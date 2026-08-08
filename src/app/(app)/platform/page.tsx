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
  const data = snapshot?.ok ? snapshot.data : null;
  const health = data?.health ?? null;

  // capability는 Admin API가 살아 있는지로만 판단한다. 감사 목록 조회가
  // 실패했다고 해서 인증 조회 기능이 사라진 것은 아니다.
  const available = health !== null;
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

  const mismatches = health?.environmentMismatches ?? [];
  const failures = data?.failures ?? [];
  // health 실패는 연결 배지가 이미 말하고 있다. 구획 목록에 또 넣으면
  // 같은 사실이 두 번 보인다.
  const sectionFailures = failures.filter((f) => f.section !== "health");
  const healthFailure = failures.find((f) => f.section === "health");

  const message = overviewMessage({
    configuredMessage: configuration.configured ? null : configuration.message,
    errorMessage:
      snapshot && !snapshot.ok ? snapshot.error : (healthFailure?.error ?? null),
    deadLetterCount: health?.deadLetterCount ?? 0,
    environmentMismatchCount: mismatches.length,
    failedSectionLabels: sectionFailures.map((f) => f.label),
  });

  return (
    <PlatformOverviewStatus
      connection={overviewConnectionState({
        configured: configuration.configured,
        healthReachable: health !== null,
        deadLetterCount: health?.deadLetterCount ?? 0,
        environmentMismatchCount: mismatches.length,
        failedSectionCount: sectionFailures.length,
        hiddenRecordCount:
          (data?.hiddenOrderCount ?? 0) + (data?.hiddenOperatorRecordCount ?? 0),
      })}
      environment={health?.environment ?? null}
      deadLetterCount={health?.deadLetterCount ?? null}
      environmentMismatches={mismatches}
      capabilities={capabilities}
      sectionFailures={sectionFailures}
      hiddenOrderCount={data?.hiddenOrderCount ?? 0}
      hiddenOperatorRecordCount={data?.hiddenOperatorRecordCount ?? 0}
      metrics={data?.metrics ?? null}
      // 조회는 성공했는데 값이 null이면 구버전 Admin API다. 실패 목록에
      // 없다는 것이 그 증거다.
      metricsUnsupported={
        data != null &&
        data.metrics === null &&
        !failures.some((f) => f.section === "metrics")
      }
      lastCheckedAt={data?.checkedAt ?? null}
      message={message}
    />
  );
}
