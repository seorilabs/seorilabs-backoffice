"use server";

import { revalidatePath } from "next/cache";
import { reconcileAll, type ReconcileRunResult } from "@/lib/sync/backfill";
import { seedRegistry, type SeedRegistryResult } from "@/lib/seed/registry";
import { requireSession } from "@/lib/auth-helpers";

// /settings 의 "전체 리싱크" 버튼.
export async function reconcileNow(): Promise<ReconcileRunResult> {
  await requireSession();
  const result = await reconcileAll();
  if (!result.ok) {
    throw new Error(
      result.state === "busy"
        ? "리싱크가 이미 실행 중입니다."
        : `리싱크 일부 실패: ${result.failed}건`,
    );
  }
  revalidatePath("/settings");
  revalidatePath("/");
  return result;
}

// /settings 의 "레지스트리 시드/재스캔" 버튼.
export async function seedRegistryAction(): Promise<SeedRegistryResult> {
  await requireSession();
  const result = await seedRegistry({ backfill: true });
  if (!result.ok) {
    throw new Error(
      result.state === "busy"
        ? "레지스트리 시드가 이미 실행 중입니다."
        : `레지스트리 시드 일부 실패: ${result.failed}건`,
    );
  }
  revalidatePath("/");
  revalidatePath("/board");
  revalidatePath("/settings");
  return result;
}
