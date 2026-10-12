import {
  PlatformIapManagement,
  type PlatformWritableApp,
} from "@/components/platform";
import Link from "next/link";
import { loadPlatformIapSnapshotAction } from "@/lib/actions/platform-read";
import { env } from "@/lib/env";
import { requirePlatformReadAccess } from "@/lib/platform/access";
import { createPlatformReadClient, platformReadConfiguration } from "@/lib/platform/read-client";
import { initialIapAppSlug, selectWritableIapApps } from "@/lib/platform/iap-apps";
import { platformSnapshotErrorMessage } from "@/lib/platform/snapshot";
import { listBlockingPlatformOperations } from "@/lib/platform/runs";
import type { PlatformBlockingReference } from "@/lib/platform/recovery";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function writableApps(): Promise<{
  apps: PlatformWritableApp[];
  blockingReferences: PlatformBlockingReference[];
  error: string | null;
}> {
  if (!env.featurePlatformWrites()) {
    return {
      apps: [],
      blockingReferences: [],
      error:
        "플랫폼 조회는 가능하지만 변경 전환은 아직 활성화되지 않았습니다.",
    };
  }
  try {
    const actor = await requirePlatformReadAccess();
    const apps = await prisma.app.findMany({
      where: {
        status: "ACTIVE",
        ...(actor.role === "ADMIN"
          ? {}
          : { owners: { some: { userId: actor.userId, role: "OWNER" } } }),
      },
      select: { id: true, slug: true, platformAppId: true, displayName: true, type: true, status: true },
      orderBy: { displayName: "asc" },
    });
    const client = createPlatformReadClient();
    const selection = await selectWritableIapApps(apps, (appId) => client.catalogEntitlements(appId));
    return {
      apps: selection.apps,
      blockingReferences: await listBlockingPlatformOperations(apps),
      error: selection.unavailableCount
        ? `${selection.unavailableCount}개 게임의 지급 준비 상태를 확인하지 못해 선택 목록에서 제외했습니다. 잠시 후 새로고침해 주세요.`
        : selection.emptyCount && !selection.apps.length
          ? "등록된 지급 상품이 없어 변경할 수 없습니다."
          : !selection.apps.length
            ? "현재 권한으로 지급할 수 있는 IAP 지원 게임이 없습니다."
            : null,
    };
  } catch {
    return {
      apps: [],
      blockingReferences: [],
      error: "플랫폼 변경 권한과 앱 소유권을 확인하지 못했습니다.",
    };
  }
}

export default async function PlatformIapPage({ searchParams }: { searchParams: Promise<{ app?: string | string[] }> }) {
  const { app: requestedApp } = await searchParams;
  const configuration = platformReadConfiguration();
  const [snapshot, writeAccess] = await Promise.all([
    configuration.configured ? loadPlatformIapSnapshotAction() : null,
    writableApps(),
  ]);
  const requested = Array.isArray(requestedApp) ? "" : requestedApp;
  const initialAppSlug = initialIapAppSlug(writeAccess.apps, requested);
  const invalidAppLink = requested !== undefined && initialAppSlug === "" && writeAccess.apps.length > 0;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900">IAP 원장</h2>
        <p className="mt-1 text-sm text-neutral-500">
          주문·권한·환불 검토·운영자 이력을 조회하고, 별도 worker를 통해 지급·회수·Sandbox 초기화·Google 환불 의견 제출을 실행합니다.
        </p>
      </div>
      <Link href="/platform/iap/crystal-testers" className="text-sm underline">크리스털 시험 계정 관리</Link>
      <PlatformIapManagement
        initialSnapshot={snapshot?.ok ? snapshot.data : null}
        initialError={
          !configuration.configured
            ? configuration.message
            : snapshot && !snapshot.ok
              ? snapshot.error
              : // 부분 실패는 snapshot이 ok인 채로 온다. 여기서 안 꺼내면
                // 이 화면에는 실패가 어디에도 안 보인다.
                snapshot?.ok
                ? platformSnapshotErrorMessage(snapshot.data)
                : null
        }
        writableApps={writeAccess.apps}
        initialAppSlug={initialAppSlug}
        initialBlockingReferences={writeAccess.blockingReferences}
        writeAccessError={[
          writeAccess.error,
          invalidAppLink
            ? "요청한 게임은 지급할 수 없습니다. IAP 지원 게임을 직접 선택해 주세요."
            : null,
        ].filter(Boolean).join(" ") || null}
      />
    </section>
  );
}
