import {
  PlatformIapManagement,
  type PlatformWritableApp,
} from "@/components/platform";
import { loadPlatformIapSnapshotAction } from "@/lib/actions/platform-read";
import { env } from "@/lib/env";
import { requirePlatformReadAccess } from "@/lib/platform/access";
import { platformReadConfiguration } from "@/lib/platform/read-client";
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
      select: { id: true, slug: true, displayName: true },
      orderBy: { displayName: "asc" },
    });
    return {
      apps: apps.map(({ slug, displayName }) => ({ slug, displayName })),
      blockingReferences: await listBlockingPlatformOperations(apps),
      error: null,
    };
  } catch {
    return {
      apps: [],
      blockingReferences: [],
      error: "플랫폼 변경 권한과 앱 소유권을 확인하지 못했습니다.",
    };
  }
}

export default async function PlatformIapPage() {
  const configuration = platformReadConfiguration();
  const [snapshot, writeAccess] = await Promise.all([
    configuration.configured ? loadPlatformIapSnapshotAction() : null,
    writableApps(),
  ]);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900">IAP 원장</h2>
        <p className="mt-1 text-sm text-neutral-500">
          주문·권한·운영자 이력을 조회하고, 별도 worker를 통해 지급·회수·Sandbox 원장 초기화를 실행합니다.
        </p>
      </div>
      <PlatformIapManagement
        initialSnapshot={snapshot?.ok ? snapshot.data : null}
        initialError={
          !configuration.configured
            ? configuration.message
            : snapshot && !snapshot.ok
              ? snapshot.error
              : null
        }
        writableApps={writeAccess.apps}
        initialBlockingReferences={writeAccess.blockingReferences}
        writeAccessError={writeAccess.error}
      />
    </section>
  );
}
