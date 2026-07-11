import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { fmtDateTime } from "@/lib/format";
import { SettingsActions } from "@/components/SettingsActions";
import { AdRevenueProbe } from "@/components/AdRevenueProbe";
import {
  visibleAppWhere,
  visibleIssueWhere,
  visiblePrWhere,
  visibleReleaseWhere,
} from "@/lib/domain/app-visibility";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [appCount, issueCount, prCount, releaseCount, lastDelivery, allowUsers] =
    await Promise.all([
      prisma.app.count({ where: visibleAppWhere }),
      prisma.issueMirror.count({ where: visibleIssueWhere }),
      prisma.pullRequestMirror.count({ where: visiblePrWhere }),
      prisma.releaseRecord.count({ where: visibleReleaseWhere }),
      prisma.webhookDelivery.findFirst({ orderBy: { receivedAt: "desc" } }),
      prisma.user.findMany({ where: { allowlisted: true }, select: { login: true } }),
    ]);

  return (
    <div className="px-4 py-6 sm:p-8">
      <h1 className="text-xl font-semibold">설정</h1>

      <section className="mt-6 max-w-xl space-y-4">
        <Card title="동기화 상태">
          <Row k="마지막 webhook 수신" v={lastDelivery ? `${fmtDateTime(lastDelivery.receivedAt)} (${lastDelivery.event})` : "없음"} />
          <Row k="앱/게임" v={`${appCount}개`} />
          <Row k="미러된 이슈 / PR" v={`${issueCount} / ${prCount}`} />
          <Row k="릴리스 레코드" v={`${releaseCount}`} />
        </Card>

        <Card title="작업">
          <SettingsActions />
        </Card>

        <Card title="Allowlist">
          <Row k="ENV ALLOWLIST_LOGINS" v={env.allowlistLogins().join(", ") || "(없음)"} />
          <Row k="허용된 사용자(DB)" v={allowUsers.map((u) => `@${u.login}`).join(", ") || "(없음)"} />
        </Card>
      </section>

      <section className="mt-4 max-w-3xl">
        <Card title="광고/수익 지표 진단">
          <AdRevenueProbe />
        </Card>
      </section>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-neutral-700">{title}</h2>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-neutral-100 py-1.5 text-sm last:border-0">
      <span className="text-neutral-500">{k}</span>
      <span className="text-neutral-800">{v}</span>
    </div>
  );
}
