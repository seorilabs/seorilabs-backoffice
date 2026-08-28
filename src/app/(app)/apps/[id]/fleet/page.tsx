import { notFound } from "next/navigation";

import { Panel, WorkspaceSection } from "@/components/app-ops/WorkspaceUi";
import { FleetConfigEditor } from "@/components/fleet/FleetConfigEditor";
import { FleetAutomationControls } from "@/components/fleet/FleetAutomationControls";
import { TrustedLocalPendingButton } from "@/components/fleet/TrustedLocalPendingButton";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import {
  isManagedAutomationDefinition,
  parseManagedAutomationPolicy,
} from "@/lib/control-plane/automation-catalog";
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
  if (["ACTIVE", "SUCCEEDED", "COMPLETED", "MANAGED", "MATCH", "READY", "PASSED", "COMPLIANT"].includes(status)) {
    return "bg-emerald-50 text-emerald-700";
  }
  if (["FAILED", "DEAD_LETTER", "REVOKED", "MISMATCH"].includes(status)) {
    return "bg-red-50 text-red-700";
  }
  if (["HUMAN_REAUTH_REQUIRED", "TRUSTED_LOCAL_PENDING", "NEEDS_REAUTH", "NEEDS_INPUT", "RUNNING"].includes(status)) {
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
  const latestParity = fleet.fleetParityWaveResults[0];
  const activePayload = configRevisionPayloadSchema.safeParse(activeConfig?.payload);
  const initialPayload = activePayload.success
    ? activePayload.data
    : { schemaVersion: 1 as const, markets: [] };
  const releaseCandidates = fleet.releaseCandidates.map((candidate) => {
    const seen = new Set<string>();
    return {
      ...candidate,
      latestGates: candidate.gateObservations.filter((observation) => {
        if (seen.has(observation.gate)) return false;
        seen.add(observation.gate);
        return true;
      }),
    };
  });
  const visibleRuns = [
    ...fleet.recentRuns,
    ...fleet.deadLetters.filter((deadLetter) => !fleet.recentRuns.some((run) => run.id === deadLetter.id)),
  ];

  return (
    <div className="space-y-8">
      <WorkspaceSection
        title="Fleet 제어면"
        description="자동 탐지·desired state·provider readback·credential 공개 identity·agent queue를 앱 단위로 대조합니다. 이 화면은 provider write를 수행하지 않습니다."
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
          <Summary label="Discovery" value={latestDiscovery ? mono(latestDiscovery.sourceSha, 12) : "미관측"} detail={dateTime(latestDiscovery?.observedAt)} />
          <Summary label="ACTIVE Config" value={activeConfig ? `revision ${activeConfig.revision}` : "없음"} detail={activeConfig ? mono(activeConfig.snapshotDigest, 12) : "새 변경 fail-closed"} />
          <Summary
            label="Parity gate"
            value={latestParity?.wave.cleanupAllowed ? "2회 연속 통과" : latestParity ? `${latestParity.wave.consecutiveMatchCount}/2` : "미실행"}
            detail={latestParity ? `${latestParity.status} · ${mono(latestParity.wave.evidenceDigest, 12)}` : "Fleet wave 증거 없음"}
            danger={Boolean(latestParity) && !latestParity.wave.cleanupAllowed}
          />
          <Summary label="Platform Fleet" value={fleet.platformFleetBinding?.state ?? "미연결"} detail={fleet.platformFleetBinding?.observedVersion ?? "observed version 없음"} />
          <Summary label="Credential Binding" value={`${fleet.credentialBindings.length}개`} detail="공개 metadata만 조회" />
          <Summary label="Dead-letter" value={`${fleet.deadLetters.length}개`} detail={`${fleet.reauthRequests.filter((request) => request.status === "HUMAN_REAUTH_REQUIRED").length}건 재인증 필요`} danger={fleet.deadLetters.length > 0} />
          <Summary label="Lifecycle" value={fleet.fleetLifecycleState?.stage ?? "IDEA"} detail={fleet.fleetLifecycleState ? `generation ${fleet.fleetLifecycleState.generation}` : "중앙 lifecycle 미시작"} />
        </div>
      </WorkspaceSection>

      <WorkspaceSection
        title="ProjectBlueprint와 마켓 정본"
        description="ACTIVE ConfigRevision에서 생성된 불변 projection입니다. 비밀값은 없으며 provider apply 전에 공개 identity와 readback 권한을 대조합니다."
      >
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="ProjectBlueprint">
            {activeConfig?.projectBlueprint ? (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <Meta label="GCP project" value={activeConfig.projectBlueprint.projectId} />
                <Meta label="Project number" value={activeConfig.projectBlueprint.projectNumber ?? "readback 대기"} />
                <Meta label="Organization" value={activeConfig.projectBlueprint.organizationId} />
                <Meta label="Folder" value={activeConfig.projectBlueprint.folderId} />
                <Meta label="Billing" value={activeConfig.projectBlueprint.billingAccountId} />
                <Meta label="Region" value={activeConfig.projectBlueprint.region} />
                <Meta label="Payload digest" value={mono(activeConfig.projectBlueprint.payloadHash, 20)} />
                <Meta label="Revision" value={String(activeConfig.revision)} />
              </dl>
            ) : <Empty>ACTIVE revision에 ProjectBlueprint가 없습니다. provider apply는 차단됩니다.</Empty>}
          </Panel>
          <Panel title="MarketProfile">
            <div className="space-y-2">
              {activeConfig?.marketProfiles.map((profile) => (
                <div key={profile.market} className="rounded border border-neutral-200 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{profile.market}</span>
                    <Status value={profile.enabled ? "ACTIVE" : "DISABLED"} />
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">
                    {profile.releaseChannel ?? "channel 없음"} · {(profile.locales as string[]).join(", ") || "locale 없음"}
                  </div>
                </div>
              ))}
              {!activeConfig?.marketProfiles.length && <Empty>MarketProfile이 없습니다.</Empty>}
            </div>
          </Panel>
          <Panel title="Localization과 StoreAsset">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <Meta label="Localization" value={`${activeConfig?.marketLocalizations.length ?? 0}개`} />
              <Meta label="Asset" value={`${activeConfig?.storeAssets.length ?? 0}개`} />
            </dl>
            <div className="mt-3 space-y-1 text-xs text-neutral-500">
              {activeConfig?.storeAssets.slice(0, 8).map((asset) => (
                <div key={`${asset.market}:${asset.kind}:${asset.objectKey}`} className="break-all font-mono">
                  {asset.market ?? "all"}/{asset.kind}/{asset.locale ?? "all"} · {asset.objectKey} · {mono(asset.checksum, 12)}
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="ComplianceProfile — 사람 승인 전 draft">
            <div className="space-y-2">
              {activeConfig?.complianceProfiles.map((profile) => (
                <div key={`${profile.market}:${profile.declaration}`} className="flex items-center justify-between gap-2 rounded border border-neutral-200 px-3 py-2 text-sm">
                  <span>{profile.market} · {profile.declaration}</span>
                  <Status value={profile.state} />
                </div>
              ))}
              {!activeConfig?.complianceProfiles.length && <Empty>Compliance draft가 없습니다.</Empty>}
            </div>
          </Panel>
        </div>
      </WorkspaceSection>

      <WorkspaceSection
        title="Release candidate와 독립 gate 원장"
        description="구현·CI·artifact·자산·compliance draft·provider shell이 모두 통과해야 release-candidate가 됩니다. Upload 이후 processing, device QA, review, approval, deployment, public은 서로 대체하지 않습니다."
      >
        <Panel title="최근 ReleaseCandidate">
          <div className="space-y-3">
            {releaseCandidates.map((candidate) => (
              <article key={candidate.id} className="rounded border border-neutral-200 bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{candidate.market ?? "legacy"} · {candidate.artifactType ?? "artifact"}</span>
                      <Status value={candidate.status} />
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                      revision {candidate.configRevision.revision} · {mono(candidate.sourceSha, 12)} · {candidate.targetKey ?? "target 미기록"}
                    </div>
                    <div className="mt-1 text-[11px] text-neutral-400">
                      artifact {mono(candidate.artifactChecksum, 16)} · bundle {mono(candidate.workflowBundleSha, 12)} · Platform {candidate.platformVersion ?? "미기록"}
                    </div>
                  </div>
                  <span className="text-xs text-neutral-400">{dateTime(candidate.createdAt)} · {candidate.createdBy}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {candidate.latestGates.map((gate) => (
                    <span key={gate.gate} className="rounded border border-neutral-200 px-2 py-1 text-[11px]">
                      {gate.gate} <Status value={gate.status} />
                    </span>
                  ))}
                  {candidate.latestGates.length === 0 && <span className="text-xs text-neutral-400">gate observation 없음</span>}
                </div>
              </article>
            ))}
            {releaseCandidates.length === 0 && <Empty>Release candidate가 없습니다.</Empty>}
          </div>
        </Panel>
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
          shadowSourceSha={latestDiscovery?.sourceSha ?? null}
          drafts={drafts.map((draft) => ({
            revision: draft.revision,
            payloadHash: draft.payloadHash,
            createdBy: draft.createdBy,
            createdAt: dateTime(draft.createdAt),
            activatable: !draft.legacyConfigImport && configRevisionPayloadSchema.safeParse(draft.payload).success,
            activationLabel: draft.legacyConfigImport
              ? `Legacy shadow import ${draft.legacyConfigImport.status} — 활성화 금지`
              : configRevisionPayloadSchema.safeParse(draft.payload).success
                ? "ACTIVE 전환"
                : "strict 계약 밖 DRAFT",
          }))}
        />
      </WorkspaceSection>

      <WorkspaceSection
        title="Legacy JSON shadow import"
        description="정확한 source SHA에서 읽은 공개 provenance와 중앙 ACTIVE 계약의 parity만 표시합니다. 원문은 저장·표시하지 않으며 imported DRAFT는 활성화할 수 없습니다. 정리는 연속 full MATCH 2회와 선언 마켓 build-only·장애 복구 증거가 모두 있어야 합니다."
      >
        <Panel title="최근 shadow import">
          <div className="space-y-3">
            {fleet.legacyConfigImports.map((legacyImport) => (
              <article key={legacyImport.id} className="rounded border border-neutral-200 bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-medium text-neutral-800">{mono(legacyImport.sourceSha, 16)}</span>
                      <Status value={legacyImport.status} />
                      {legacyImport.configRevision && (
                        <span className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">
                          DRAFT revision {legacyImport.configRevision.revision}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                      {legacyImport.sourceRef ?? "sourceRef 없음"} · {legacyImport.transformVersion} · {legacyImport.observedBy} · {dateTime(legacyImport.observedAt)}
                    </div>
                    <div className="mt-1 text-[11px] text-neutral-400">input digest {mono(legacyImport.inputDigest, 20)}</div>
                  </div>
                  <span className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
                    정리 금지 · Fleet wave 2회와 복구·build-only 증거를 별도로 확인
                  </span>
                </div>

                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[900px] text-left text-[11px]">
                    <thead className="border-b border-neutral-200 text-neutral-500">
                      <tr><th className="py-1.5 pr-3">Source</th><th className="pr-3">Repository</th><th className="pr-3">상태</th><th className="pr-3">Blob</th><th className="pr-3">Content SHA-256</th><th>관측</th></tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {legacyImport.sources.map((source) => (
                        <tr key={source.id}>
                          <td className="max-w-72 py-1.5 pr-3 align-top">
                            <div className="font-medium text-neutral-700">{source.sourceKind}</div>
                            <div className="break-all font-mono text-neutral-500">{source.path}</div>
                          </td>
                          <td className="pr-3 align-top text-neutral-600">
                            <div>{source.repoFullName} · ID {source.repoId ?? "—"}</div>
                            <div className="font-mono text-neutral-400">{mono(source.sourceSha, 12)}{source.sourceRef ? ` · ${source.sourceRef}` : ""}</div>
                          </td>
                          <td className="pr-3 align-top"><Status value={source.status} />{source.errorCode ? <div className="mt-1 text-red-600">{source.errorCode}</div> : null}</td>
                          <td className="pr-3 align-top font-mono text-neutral-500">{mono(source.blobSha, 14)}</td>
                          <td className="pr-3 align-top font-mono text-neutral-500">{mono(source.contentSha256, 14)}</td>
                          <td className="align-top text-neutral-500">{dateTime(source.observedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {legacyImport.sources.length === 0 && <Empty>Source metadata가 없습니다.</Empty>}
                </div>

                <div className="mt-3 space-y-2">
                  {legacyImport.parityObservations.map((parity) => (
                    <details key={parity.id} className="rounded border border-neutral-200 px-3 py-2">
                      <summary className="cursor-pointer text-xs text-neutral-700">
                        <span className="mr-2 inline-block"><Status value={parity.status} /></span>
                        {parity.scope} · contract {parity.contractVersion} · {dateTime(parity.observedAt)}
                      </summary>
                      <dl className="mt-2 grid gap-1 text-[11px] sm:grid-cols-2">
                        <Meta label="비교 Config" value={parity.configRevisionId ? mono(parity.configRevisionId, 16) : "없음"} />
                        <Meta label="관측자" value={parity.observedBy} />
                        <Meta label="Legacy digest" value={mono(parity.legacyDigest, 16)} />
                        <Meta label="Central digest" value={mono(parity.centralDigest, 16)} />
                      </dl>
                      <pre className="mt-2 max-h-48 overflow-auto rounded bg-neutral-950 p-3 text-[11px] text-neutral-100">{jsonText(parity.diff ?? [])}</pre>
                    </details>
                  ))}
                  {legacyImport.parityObservations.length === 0 && <Empty>Parity observation이 없습니다.</Empty>}
                </div>
              </article>
            ))}
            {fleet.legacyConfigImports.length === 0 && <Empty>Legacy shadow import가 없습니다.</Empty>}
          </div>
        </Panel>
      </WorkspaceSection>

      <WorkspaceSection
        title="Fleet parity wave"
        description="ACTIVE·MANAGED cohort를 한 번에 고정해 비교합니다. 동일 exact vector가 별도 occurrence에서 두 번 연속 FULL MATCH여야 parity 선행조건이 열립니다."
      >
        <Panel title="최근 앱별 wave 결과">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-xs">
              <thead className="border-b border-neutral-200 text-neutral-500">
                <tr>
                  <th className="py-2 pr-3">Wave</th><th className="pr-3">결과</th><th className="pr-3">Exact vector</th><th className="pr-3">전체 cohort</th><th>증거</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {fleet.fleetParityWaveResults.map((result) => (
                  <tr key={result.id}>
                    <td className="py-2 pr-3 align-top">
                      <div className="font-mono text-neutral-700">{mono(result.wave.id, 14)}</div>
                      <div className="text-[11px] text-neutral-400">{dateTime(result.wave.completedAt ?? result.wave.startedAt)}</div>
                    </td>
                    <td className="pr-3 align-top">
                      <Status value={result.status} />
                      <div className="mt-1 text-[11px] text-neutral-500">{result.reasonCode ?? `${result.sourceCount} sources`}</div>
                    </td>
                    <td className="pr-3 align-top font-mono text-[11px] text-neutral-500">
                      <div>SHA {mono(result.sourceSha, 12)}</div>
                      <div>Config {mono(result.configRevisionId, 12)}</div>
                      <div>{result.scope} · {result.contractVersion}</div>
                    </td>
                    <td className="pr-3 align-top text-neutral-600">
                      <div><Status value={result.wave.status} /> · {result.wave.matchCount}/{result.wave.resultCount}</div>
                      <div className="mt-1">연속 {result.wave.consecutiveMatchCount}/2 · parity 정리 선행조건 {result.wave.cleanupAllowed ? "충족" : "차단"}</div>
                    </td>
                    <td className="align-top font-mono text-[11px] text-neutral-500">
                      <div>cohort {mono(result.wave.cohortDigest, 14)}</div>
                      <div>vector {mono(result.wave.vectorDigest, 14)}</div>
                      <div>evidence {mono(result.wave.evidenceDigest, 14)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {fleet.fleetParityWaveResults.length === 0 && <Empty>아직 Fleet parity wave가 없습니다.</Empty>}
          </div>
        </Panel>
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

      <WorkspaceSection title="Automation queue" description="routine 생성·즉시/정기 실행·pause/cancel/retry를 같은 API 계약으로 처리합니다. lease token은 저장·표시하지 않습니다.">
        <FleetAutomationControls
          appId={fleet.id}
          definitions={fleet.automationDefinitions.map((definition) => {
            const policy = parseManagedAutomationPolicy(definition.configuration);
            const managed = isManagedAutomationDefinition(definition);
            return {
              id: definition.id,
              key: definition.key,
              template: definition.template,
              schedule: definition.schedule,
              agentKind: definition.agentKind,
              model: definition.model,
              enabled: definition.enabled && managed,
              managed,
              maxAttempts: definition.maxAttempts,
              approvalPolicy: policy?.approvalPolicy ?? "UNMANAGED",
              budgetCeilingMicros: policy?.budgetCeilingMicros ?? 0,
            };
          })}
          runs={visibleRuns.map((run) => ({
            id: run.id,
            definitionId: run.occurrence.definition.id,
            definitionKey: run.occurrence.definition.key,
            issueNumber: run.issueNumber,
            status: run.status,
            attempts: run.attempts,
            maxAttempts: run.maxAttempts,
            spentMicros: run.spentMicros,
            workerId: run.leases[0]?.workerId ?? null,
            updatedAt: dateTime(run.updatedAt),
            error: run.error,
            outcome: run.outcome,
          }))}
        />
      </WorkspaceSection>

      <WorkspaceSection
        title="Seorilabs Fleet Project projection"
        description="Priority·App·Kind·Lifecycle·Agent·Approval·Outcome desired state입니다. 표시 projection은 실행 claim과 완전히 분리되어 있습니다."
      >
        <Panel>
          <div className="space-y-2">
            {fleet.fleetProjectProjections.map((projection) => (
              <details key={projection.id} className="rounded border border-neutral-200 px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium text-neutral-800">
                  #{projection.issueNumber} <Status value={projection.status} />
                  <span className="ml-2 text-xs font-normal text-neutral-400">{dateTime(projection.updatedAt)}</span>
                </summary>
                <div className="mt-2 grid gap-2 lg:grid-cols-2">
                  <pre className="overflow-auto rounded bg-neutral-950 p-3 text-[11px] text-neutral-100">{jsonText(projection.desired)}</pre>
                  <pre className="overflow-auto rounded bg-neutral-100 p-3 text-[11px] text-neutral-700">{jsonText(projection.observed ?? { status: "readback pending" })}</pre>
                </div>
                {projection.lastError && <p className="mt-2 text-xs text-red-700">{projection.lastError}</p>}
              </details>
            ))}
            {fleet.fleetProjectProjections.length === 0 && <Empty>아직 Project projection 관측이 없습니다.</Empty>}
          </div>
        </Panel>
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
