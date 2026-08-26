"use server";

import { revalidatePath } from "next/cache";
import { reconcileAll } from "@/lib/sync/backfill";
import { seedRegistry } from "@/lib/seed/registry";
import { requireSession } from "@/lib/auth-helpers";

// /settings 의 "전체 리싱크" 버튼.
export async function reconcileNow(): Promise<{ repos: number; ok: boolean }> {
  await requireSession();
  const result = await reconcileAll();
  revalidatePath("/settings");
  revalidatePath("/");
  return result;
}

// /settings 의 "레지스트리 시드/재스캔" 버튼.
export async function seedRegistryAction(): Promise<{
  seeded: number;
  skipped: number;
  backfilled: number;
  platformBound: number;
}> {
  await requireSession();
  const result = await seedRegistry({ backfill: true });
  revalidatePath("/");
  revalidatePath("/board");
  revalidatePath("/settings");
  return result;
}
