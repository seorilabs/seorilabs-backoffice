import { notFound } from "next/navigation";

import { Panel, WorkspaceSection } from "@/components/app-ops/WorkspaceUi";
import { FleetConfigEditor } from "@/components/fleet/FleetConfigEditor";
import { TrustedLocalPendingButton } from "@/components/fleet/TrustedLocalPendingButton";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { getFleetOperationsView } from "@/lib/control-plane/fleet-view";
import { requirePlatformReadAccess } from "@/lib/platform/access";

export const dynamic = "force-dynamic";

function dateTime(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Seoul",
  }).format(value);
}

function mono(value: string | null | undefined, size = 16): string {
  if (!value) return "—";
  return value.length > size ? `${value.slice(0, size)}…` : value;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function statusClass(status: string): string {
  if (["ACTIVE", "SUCCEEDED", "COMPLETED", "MANAGED"].includes(status)) {
    return "bg-emerald-50 text-emerald-700";
  }
  if (["FAILED", "DEAD_LETTER", "REVOKED"].includes(status)) {
    return "bg-red-50 text-red-700";
  }
  if (["HUMAN_REAUTH_REQUIRED", "TRUSTED_LOCAL_PENDING", "NEEDS_REAUTH", "RUNNING"].includes(status)) {
    return "bg-amber-50 text-amber-800";
  }
  return "bg-neutral-100 text-neutral-600";
}

function Status({ value }: { value: string }) {
  return <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${statusClass(value)}`}>{value}</span>;
}

export default async function FleetOperationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePlatformReadAccess();
  const { id } = await params;
  const fleet = await getFleetOperationsView(id);
  if (!fleet) notFound();

  const activeConfig = fleet.configRevisions.find((revision) => revision.status === "ACTIVE");
  const drafts = fleet.configRevisions.filter((revision) => revision.status === "DRAFT");
  const latestDiscovery = fleet.discoveryObservations[0];
  const activePayload = configRevisionPayloadSchema.safeParse(activeConfig?.payload);
  const initialPayload = activePayload.success
    ? activePayload.data
    : { schemaVersion: 1 as const, markets: [] };

  return (
    <div className="space-y-8">
      <WorkspaceSection
        title="Fleet 제어면"
        description="자동 탐지·desired state·provider readback·credential 공개 identity·agent queue를 앱 단위로 대조합니다. 이 화면은 provider write를 수행하지 않습니다."
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Summary label="Discovery" value={latestDiscovery ? mono(latestDiscovery.sourceSha, 12) : "미관측"} detail={dateTime(latestDiscovery?.observedAt)} />
          <Summary label="ACTIVE Config" value={activeConfig ? `revision ${activeConfig.revision}` : "없음"} detail={activeConfig ? mono(activeConfig.snapshotDigest, 12) : "새 변경 fail-closed"} />
          <Summary label="Platform Fleet" value={fleet.platformFleetBinding?.state ?? "미연결"} detail={fleet.platformFleetBinding?.observedVersion ?? "observed version 없음"} />
          <Summary label="Credential Binding" value={`${fleet.credentialBindings.length}개`} detail="공개 metadata만 조회" />
          <Summary label="Dead-letter" value={`${fleet.deadLetters.length}개`} detail={`${fleet.reauthRequests.filter((request) => request.status === "HUMAN_REAUTH_REQUIRED").length}건 재인증 필요`} danger={fleet.deadLetters.length > 0} />
        </div>
      </WorkspaceSection>

      <WorkspaceSection
        title="ConfigRevision"
        description="검증과 저장, activation 모두 internal API와 같은 validator/service를 사용합니다. ACTIVE snapshot은 생성 후 수정되지 않습니다."
      >
        <FleetConfigEditor
          appId={fleet.id}
          activeRevision={activeConfig?.revision ?? 0}
          initialPayload={jsonText(initialPayload)}
          legacyActiveBlocked={Boolean(activeConfig) && !activePayload.success}
          drafts={drafts.map((draft) => ({
            revision: draft.revision,
            payloadHash: draft.payloadHash,
            createdBy: draft.createdBy,
            createdAt: dateTime(draft.createdAt),
            activatable: configRevisionPayloadSchema.safeParse(draft.payload).success,
          }))}
        />
      </WorkspaceSection>

      <WorkspaceSection title="관측과 binding" description="observation은 append-only이며 credential은 logical ID와 공개 identity만 표시합니다.">
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="DiscoveryObservation">
            <ObservationList
              empty="Discovery observation이 없습니다."
              rows={fleet.discoveryObservations.map((row) => ({
                id: row.id,
                title: `${mono(row.sourceSha, 12)}${row.sourceRef ? ` · ${row.sourceRef}` : ""}`,
                subtitle: `${dateTime(row.observedAt)} · ${row.observedBy} · ${row.workflowProfile ?? "caller 미탐지"}/${row.workflowPackageManager ?? "—"} @ ${row.workflowWorkingDirectory ?? "—"}`,
                payload: row.payload,
              }))}
            />
          </Panel>
          <Panel title="ProviderObservation">
            <ObservationList
              empty="Provider observation이 없습니다."
              rows={fleet.providerObservations.map((row) => ({
                id: row.id,
                title: `${row.provider} · ${row.resourceType} · ${row.resourceId}`,
                subtitle: `${dateTime(row.observedAt)} · ${row.observedBy}`,
                payload: row.payload,
              }))}
            />
          </Panel>
          <Panel title="PlatformFleetBinding">
            {fleet.platformFleetBinding ? (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <Meta label="상태" value={fleet.platformFleetBinding.state} />
                <Meta label="Observed" value={fleet.platformFleetBinding.observedVersion} />
                <Meta label="Approved" value={fleet.platformFleetBinding.approvedVersion} />
                <Meta label="Contract" value={fleet.platformFleetBinding.contractRevision} />
                <Meta label="Source SHA" value={mono(fleet.platformFleetBinding.sourceSha, 12)} />
                <Meta label="예외 만료" value={dateTime(fleet.platformFleetBinding.exceptionExpiresAt)} />
              </dl>
            ) : <Empty>Platform Fleet binding이 없습니다.</Empty>}
          </Panel>
          <Panel title="CredentialBinding — read-only">
            <div className="space-y-2">
              {fleet.credentialBindings.map((binding) => (
                <div key={binding.id} className="rounded border border-neutral-200 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-neutral-800">{binding.provider} · {binding.capability}</span>
                    <Status value={binding.status} />
                  </div>
                  <div className="mt-1 grid gap-1 text-xs text-neutral-500 sm:grid-cols-2">
                    <span>logical ID: <code>{binding.logicalCredentialId}</code></span>
                    <span>identity: {binding.publicIdentity ?? "—"}</span>
                    <span>fingerprint: {mono(binding.fingerprint, 20)}</span>
                    <span>{binding.environment} · {binding.consumer}</span>
                  </div>
                </div>
              ))}
              {fleet.credentialBindings.length === 0 && <Empty>등록된 공개 credential binding이 없습니다.</Empty>}
            </div>
          </Panel>
        </div>
      </WorkspaceSection>

      <WorkspaceSection title="Automation queue" description="최근 run과 dead-letter를 함께 표시합니다. lease token은 저장·표시하지 않습니다.">
        <Panel title="AutomationDefinition">
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {fleet.automationDefinitions.map((definition) => (
              <div key={definition.id} className="rounded border border-neutral-200 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{definition.key}</span>
                  <Status value={definition.enabled ? "ACTIVE" : "DISABLED"} />
                </div>
                <div className="mt-1 text-xs text-neutral-500">{definition.template}</div>
                <div className="mt-1 text-xs text-neutral-400">{definition.schedule ?? "수동"} · 최대 {definition.maxAttempts}회</div>
              </div>
            ))}
            {fleet.automationDefinitions.length === 0 && <Empty>Automation definition이 없습니다.</Empty>}
          </div>
        </Panel>
        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <Panel title="최근 AgentRun">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="border-b border-neutral-200 text-neutral-500">
                    <tr><th className="py-2">Definition</th><th>대상</th><th>상태</th><th>시도</th><th>Lease</th><th>갱신</th></tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {fleet.recentRuns.map((run) => (
                      <tr key={run.id}>
                        <td className="py-2 pr-3 font-medium">{run.occurrence.definition.key}</td>
                        <td className="pr-3">{run.issueNumber ? `#${run.issueNumber}` : mono(run.id, 10)}</td>
                        <td className="pr-3"><Status value={run.status} /></td>
                        <td className="pr-3">{run.attempts}/{run.maxAttempts}</td>
                        <td className="pr-3">{run.leases[0] ? `${run.leases[0].workerId} · g${run.leases[0].generation}` : "—"}</td>
                        <td>{dateTime(run.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {fleet.recentRuns.length === 0 && <Empty>Agent run이 없습니다.</Empty>}
              </div>
            </Panel>
          </div>
          <Panel title="Dead-letter">
            <div className="space-y-2">
              {fleet.deadLetters.map((run) => (
                <div key={run.id} className="rounded border border-red-200 bg-red-50/50 px-3 py-2 text-xs">
                  <div className="font-medium text-red-800">{run.occurrence.definition.key} {run.issueNumber ? `#${run.issueNumber}` : ""}</div>
                  <div className="mt-1 text-red-700">{run.error ?? "오류 상세 없음"}</div>
                  <div className="mt-1 text-red-500">{run.attempts}/{run.maxAttempts} · {dateTime(run.updatedAt)}</div>
                </div>
              ))}
              {fleet.deadLetters.length === 0 && <Empty>Dead-letter가 없습니다.</Empty>}
            </div>
          </Panel>
        </div>
      </WorkspaceSection>

      <WorkspaceSection
        title="사람 재인증 대기"
        description="공개 account ID와 gate만 기록합니다. 비밀번호·TOTP·cookie·복구 코드 입력 또는 조회 UI는 제공하지 않습니다."
      >
        <Panel>
          <div className="space-y-2">
            {fleet.reauthRequests.map((request) => (
              <div key={request.id} className="flex flex-col gap-3 rounded border border-neutral-200 px-3 py-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{request.provider} · {request.gate}</span>
                    <Status value={request.status} />
                  </div>
                  <div className="mt-1 text-xs text-neutral-600">{request.origin} · account {request.publicAccountId}</div>
                  <div className="mt-1 text-xs text-neutral-500">{request.capability} · {request.reason}</div>
                  <div className="mt-1 text-[11px] text-neutral-400">요청 {dateTime(request.createdAt)} · {request.requestedBy}{request.runId ? ` · run ${mono(request.runId, 10)}` : ""}</div>
                </div>
                {request.status === "HUMAN_REAUTH_REQUIRED" ? (
                  <TrustedLocalPendingButton appId={fleet.id} requestId={request.id} generation={request.generation} />
                ) : (
                  <div className="text-right text-xs text-amber-700">trusted local 처리 대기<br />{dateTime(request.trustedLocalRequestedAt)}</div>
                )}
              </div>
            ))}
            {fleet.reauthRequests.length === 0 && <Empty>사람 재인증 요청이 없습니다.</Empty>}
          </div>
        </Panel>
      </WorkspaceSection>
    </div>
  );
}

function Summary({ label, value, detail, danger = false }: { label: string; value: string; detail: string; danger?: boolean }) {
  return (
    <div className={`rounded-lg border bg-white p-3 ${danger ? "border-red-200" : "border-neutral-200"}`}>
      <div className="text-xs text-neutral-500">{label}</div>
      <div className={`mt-1 font-semibold ${danger ? "text-red-700" : "text-neutral-900"}`}>{value}</div>
      <div className="mt-1 truncate text-[11px] text-neutral-400">{detail}</div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string | null | undefined }) {
  return <div className="flex justify-between gap-3"><dt className="text-neutral-500">{label}</dt><dd className="text-right text-neutral-800">{value ?? "—"}</dd></div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-5 text-center text-sm text-neutral-400">{children}</div>;
}

function ObservationList({ rows, empty }: { rows: Array<{ id: string; title: string; subtitle: string; payload: unknown }>; empty: string }) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <details key={row.id} className="rounded border border-neutral-200 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-neutral-800">
            {row.title}<span className="ml-2 text-xs font-normal text-neutral-400">{row.subtitle}</span>
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-neutral-950 p-3 text-[11px] text-neutral-100">{jsonText(row.payload)}</pre>
        </details>
      ))}
    </div>
  );
}
