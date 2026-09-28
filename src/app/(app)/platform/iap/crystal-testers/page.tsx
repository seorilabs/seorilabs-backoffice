import Link from "next/link";

import {LizardEconomyTesterPanel} from "@/components/platform/LizardEconomyTesterPanel";
import {requirePlatformWriteAccess} from "@/lib/platform/access";

export const dynamic = "force-dynamic";

export default async function CrystalTestersPage() {
  await requirePlatformWriteAccess("lizard-tycoon");
  return <section className="space-y-4">
    <Link href="/platform/iap" className="text-sm underline">IAP 원장으로 돌아가기</Link>
    <h2 className="text-lg font-semibold">크리스털 시험 계정 관리</h2>
    <LizardEconomyTesterPanel />
  </section>;
}
