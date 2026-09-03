import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Panel, WorkspaceSection } from "@/components/app-ops/WorkspaceUi";
import { FleetConfigEditor } from "@/components/fleet/FleetConfigEditor";
import { FleetAutomationControls } from "@/components/fleet/FleetAutomationControls";
import { FleetLifecycleControls } from "@/components/fleet/FleetLifecycleControls";
import { LegacyConfigResolutionButton } from "@/components/fleet/LegacyConfigResolutionButton";
import { ProviderExecutionApprovalButton } from "@/components/fleet/ProviderExecutionApprovalButton";
import { TrustedLocalPendingButton } from "@/components/fleet/TrustedLocalPendingButton";
import {
  configRevisionPayloadSchema,
  legacyConfigResolutionReasonCodeSchema,
  type LegacyConfigResolutionRequest,
} from "@/lib/control-plane/contracts";
import {
  isManagedAutomationDefinition,
  parseManagedAutomationPolicy,
} from "@/lib/control-plane/automation-catalog";
import { getFleetOperationsView } from "@/lib/control-plane/fleet-view";
import { configOptionLabel, lifecycleStageLabel, managementStatusLabel, releaseGateLabel } from "@/lib/control-plane/presentation";
import { githubInstallationProviderPayloadSchema } from "@/lib/control-plane/github-installation-observation";
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
  if (["ACTIVE", "SUCCEEDED", "COMPLETED", "MANAGED", "MATCH", "READY", "PASSED", "COMPLIANT", "PR_MERGED", "ISSUE_OPEN", "GRANTED", "RESOLUTION_REUSED"].includes(status)) {
    return "bg-emerald-50 text-emerald-700";
  }
  if (["FAILED", "DEAD_LETTER", "REVOKED", "MISMATCH", "BLOCKED", "MISSING_REQUIREMENT"].includes(status)) {
    return "bg-red-50 text-red-700";
  }
  if (["HUMAN_REAUTH_REQUIRED", "TRUSTED_LOCAL_PENDING", "NEEDS_REAUTH", "NEEDS_INPUT", "DRAFT_CREATED_WITH_INPUT", "RUNNING", "WAITING_HUMAN_APPROVAL", "READBACK_REQUIRED"].includes(status)) {
    return "bg-amber-50 text-amber-800";
  }
  return "bg-neutral-100 text-neutral-600";
}

function Status({ value }: { value: string }) {
  return <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${statusClass(value)}`} title={value}>{managementStatusLabel(value)}</span>;
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
  const latestShadowDraft = drafts.find((revision) => (
    revision.legacyConfigImport?.status?.startsWith("DRAFT_CREATED")
    && configRevisionPayloadSchema.safeParse(revision.payload).success
  ));
  const latestObservedDiscovery = fleet.discoveryObservations[0];
  const latestDiscovery = fleet.discoveryCurrent ? latestObservedDiscovery : undefined;
  const latestObservedParity = fleet.fleetParityWaveResults[0];
  const latestParity = latestDiscovery
    && activeConfig
    && latestObservedParity?.sourceSha === latestDiscovery.sourceSha
    && latestObservedParity.configRevisionId === activeConfig.id
    ? latestObservedParity
    : undefined;
  const activePayload = configRevisionPayloadSchema.safeParse(activeConfig?.payload);
  const shadowPayload = configRevisionPayloadSchema.safeParse(latestShadowDraft?.payload);
  const initialPayload = activePayload.success
    ? activePayload.data
    : shadowPayload.success
      ? shadowPayload.data
      : { schemaVersion: 1 as const, markets: [] };
  const initialPayloadSource = activePayload.success
    ? "ACTIVE" as const
    : shadowPayload.success
      ? "LEGACY_SHADOW" as const
      : "EMPTY" as const;
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
  const githubInstallation = fleet.providerObservations
    .filter((observation) => (
      observation.provider === "github"
      && observation.resourceType === "github-app-installation"
    ))
    .map((observation) => ({
      observation,
      parsed: githubInstallationProviderPayloadSchema.safeParse(observation.payload),
    }))
    .find((item) => item.parsed.success);
  type LegacyEvidenceKind = LegacyConfigResolutionRequest["dispositions"][number]["targets"][number];
  const availableLegacyEvidenceKinds: LegacyEvidenceKind[] = [
    ...(activeConfig ? ["CONFIG_REVISION" as const] : []),
    ...(fleet.buildTargets.length > 0 ? ["BUILD_TARGET" as const] : []),
    ...(fleet.externalBindings.length > 0 ? ["EXTERNAL_BINDING" as const] : []),
    ...((activeConfig?.marketLocalizations.length ?? 0) > 0 ? ["MARKET_LOCALIZATION" as const] : []),
    ...((activeConfig?.complianceProfiles.length ?? 0) > 0 ? ["COMPLIANCE_PROFILE" as const] : []),
    ...((activeConfig?.storeAssets.length ?? 0) > 0 ? ["STORE_ASSET" as const] : []),
    ...(fleet.providerObservations.length > 0 ? ["PROVIDER_OBSERVATION" as const] : []),
    ...(fleet.platformFleetBinding ? ["PLATFORM_FLEET_BINDING" as const] : []),
    ...(fleet.credentialBindings.length > 0 ? ["CREDENTIAL_BINDING" as const] : []),
    ...(fleet.automationDefinitions.length > 0 ? ["AUTOMATION_DEFINITION" as const] : []),
  ];

  return (
    <div className="space-y-8">
      <WorkspaceSection
        title="앱 통합 관리"
        description="앱 설정, 마켓·서비스 상태, 연결 계정, 자동 작업을 한곳에서 확인합니다. 비밀값은 표시하지 않으며 승인이 필요한 작업은 한 건씩 승인합니다."
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-8">
          <Summary
            label="소스 확인"
            value={latestDiscovery ? mono(latestDiscovery.sourceSha, 12) : latestObservedDiscovery ? "재탐지 대기" : "미관측"}
            detail={latestDiscovery
              ? dateTime(latestDiscovery.observedAt)
              : fleet.repositoryRegistration?.lastDiscoveryReason ?? "현재 소스 확인 기록 없음"}
            danger={Boolean(latestObservedDiscovery) && !latestDiscovery}
          />
          <Summary
            label="저장소 분류"
            value={managementStatusLabel(fleet.repositoryRegistration?.classification
              ?? (fleet.repositoryRegistration?.managementKind === "APP" ? "기존 앱" : "미분류"))}
            detail={fleet.repositoryRegistration
              ? `${managementStatusLabel(fleet.repositoryRegistration.status)} · ${fleet.repositoryRegistration.discoveryContractVersion ?? "이전 규격"}`
              : "등록 정보 없음"}
            danger={!fleet.repositoryRegistration?.classification}
          />
          <Summary label="적용 중인 설정" value={activeConfig ? `설정 버전 ${activeConfig.revision}` : "없음"} detail={activeConfig ? mono(activeConfig.snapshotDigest, 12) : "확인 전 변경 차단"} />
          <Summary
            label="기존 설정 비교"
            value={latestParity?.wave.cleanupAllowed
              ? "2회 연속 통과"
              : latestParity
                ? `${latestParity.wave.consecutiveMatchCount}/2`
                : latestObservedParity
                  ? "현재 소스·설정 미확인"
                  : "미실행"}
            detail={latestParity
              ? `${managementStatusLabel(latestParity.status)} · ${mono(latestParity.wave.evidenceDigest, 12)}`
              : latestObservedParity
                ? "이전 비교 결과는 이력에서 확인"
                : "전체 앱 비교 기록 없음"}
            danger={Boolean(latestObservedParity) && (!latestParity || !latestParity.wave.cleanupAllowed)}
          />
          <Summary label="공통 기능 버전" value={managementStatusLabel(fleet.platformFleetBinding?.state ?? "미연결")} detail={fleet.platformFleetBinding?.observedVersion ?? "적용 버전 미확인"} />
          <Summary label="연결 계정·키" value={`${fleet.credentialBindings.length}개`} detail="비밀값을 제외한 연결 정보" />
          <Summary label="처리 실패 작업" value={`${fleet.deadLetters.length}개`} detail={`${fleet.reauthRequests.filter((request) => request.status === "HUMAN_REAUTH_REQUIRED").length}건 재인증 필요`} danger={fleet.deadLetters.length > 0} />
          <Summary label="개발·출시 단계" value={lifecycleStageLabel(fleet.fleetLifecycleState?.stage ?? "IDEA")} detail={fleet.fleetLifecycleState ? `변경 차수 ${fleet.fleetLifecycleState.generation}` : "개발·출시 단계 미설정"} />
        </div>
      </WorkspaceSection>

      <WorkspaceSection
        title="클라우드·마켓 설정"
        description="현재 적용된 설정입니다. 외부 서비스에 반영하기 전에 연결 계정과 결과 조회 권한을 확인합니다. 비밀값은 표시하지 않습니다."
      >
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="클라우드 구성">
            {activeConfig?.projectBlueprint ? (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <Meta label="GCP 프로젝트" value={activeConfig.projectBlueprint.projectId} />
                <Meta label="프로젝트 번호" value={activeConfig.projectBlueprint.projectNumber ?? "외부 결과 확인 대기"} />
                <Meta label="조직" value={activeConfig.projectBlueprint.organizationId} />
                <Meta label="폴더" value={activeConfig.projectBlueprint.folderId} />
                <Meta label="결제 계정" value={activeConfig.projectBlueprint.billingAccountId} />
                <Meta label="지역" value={activeConfig.projectBlueprint.region} />
                <Meta label="설정 확인값" value={mono(activeConfig.projectBlueprint.payloadHash, 20)} />
                <Meta label="설정 버전" value={String(activeConfig.revision)} />
              </dl>
            ) : <Empty>현재 설정에 클라우드 구성이 없어 외부 서비스에 반영할 수 없습니다.</Empty>}
          </Panel>
          <Panel title="마켓 설정">
            <div className="space-y-2">
              {activeConfig?.marketProfiles.map((profile) => (
                <div key={profile.market} className="rounded border border-neutral-200 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{configOptionLabel(profile.market)}</span>
                    <Status value={profile.enabled ? "ACTIVE" : "DISABLED"} />
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">
                    {configOptionLabel(profile.releaseChannel ?? "배포 채널 없음")} · {(profile.locales as string[]).join(", ") || "언어 미설정"}
                  </div>
                </div>
              ))}
              {!activeConfig?.marketProfiles.length && <Empty>마켓 설정이 없습니다.</Empty>}
            </div>
          </Panel>
          <Panel title="스토어 소개·이미지">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <Meta label="언어별 소개" value={`${activeConfig?.marketLocalizations.length ?? 0}개`} />
              <Meta label="이미지·파일" value={`${activeConfig?.storeAssets.length ?? 0}개`} />
            </dl>
            <div className="mt-3 space-y-1 text-xs text-neutral-500">
              {activeConfig?.storeAssets.slice(0, 8).map((asset) => (
                <div key={`${asset.market}:${asset.kind}:${asset.objectKey}`} className="break-all font-mono">
                  {configOptionLabel(asset.market ?? "전체")}/{configOptionLabel(asset.kind)}/{asset.locale ?? "전체 언어"} · {asset.objectKey} · {mono(asset.checksum, 12)}
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="정책·신고 정보 초안">
            <div className="space-y-2">
              {activeConfig?.complianceProfiles.map((profile) => (
                <div key={`${profile.market}:${profile.declaration}`} className="flex items-center justify-between gap-2 rounded border border-neutral-200 px-3 py-2 text-sm">
                  <span>{configOptionLabel(profile.market)} · {configOptionLabel(profile.declaration)}</span>
                  <Status value={profile.state} />
                </div>
              ))}
              {!activeConfig?.complianceProfiles.length && <Empty>정책·신고 정보 초안이 없습니다.</Empty>}
            </div>
          </Panel>
        </div>
      </WorkspaceSection>

      <WorkspaceSection
        title="출시 후보·단계별 확인"
        description="기능 구현, 자동 검사, 빌드, 출시 자료, 정책 초안, 마켓 앱 등록을 모두 확인해야 출시 후보가 됩니다. 업로드·마켓 처리·실기기 확인·심사·승인·배포·공개 확인은 각각 별도로 기록합니다."
      >
        <Panel title="최근 출시 후보">
          <div className="space-y-3">
            {releaseCandidates.map((candidate) => (
              <article key={candidate.id} className="rounded border border-neutral-200 bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{configOptionLabel(candidate.market ?? "이전 등록")} · {candidate.artifactType ?? "빌드 결과물"}</span>
                      <Status value={candidate.status} />
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                      설정 버전 {candidate.configRevision.revision} · {mono(candidate.sourceSha, 12)} · {candidate.targetKey ?? "빌드 대상 미기록"}
                    </div>
                    <div className="mt-1 text-[11px] text-neutral-400">
                      빌드 파일 {mono(candidate.artifactChecksum, 16)} · 공통 빌드 {mono(candidate.workflowBundleSha, 12)} / {mono(candidate.workflowBundleDigest, 12)} · 공통 기능 {candidate.platformVersion ?? "미기록"}
                    </div>
                  </div>
                  <span className="text-xs text-neutral-400">{dateTime(candidate.createdAt)} · {candidate.createdBy}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {candidate.latestGates.map((gate) => (
                    <span key={gate.gate} className="rounded border border-neutral-200 px-2 py-1 text-[11px]">
                      {releaseGateLabel(gate.gate)} <Status value={gate.status} />
                    </span>
                  ))}
                  {candidate.latestGates.length === 0 && <span className="text-xs text-neutral-400">단계별 확인 기록 없음</span>}
                </div>
              </article>
            ))}
            {releaseCandidates.length === 0 && <Empty>출시 후보가 없습니다.</Empty>}
          </div>
        </Panel>
      </WorkspaceSection>

      <WorkspaceSection
        title="개발·출시 단계"
        description="아이디어부터 출시 자료 준비까지는 사용자가 한 단계씩 진행합니다. 출시 후보부터는 해당 빌드와 마켓 계정의 확인 결과가 있어야 진행합니다. 단계를 건너뛰거나 상태 표시만 바꿔 완료할 수 없습니다."
      >
        <FleetLifecycleControls
          appId={fleet.id}
          stage={fleet.fleetLifecycleState?.stage ?? "IDEA"}
          generation={fleet.fleetLifecycleState?.generation ?? 0}
        />
      </WorkspaceSection>

      <WorkspaceSection
        title="마켓·서비스 작업 이력"
        description="각 작업에 앱, 소스 버전, 적용 설정, 연결 계정을 고정해 기록합니다. 요청 전송이나 업로드 응답만으로 완료하지 않고 외부 서비스의 실제 결과를 다시 확인합니다."
      >
        <Panel>
          <div className="space-y-3">
            {fleet.providerExecutions.map((execution) => (
              <article key={execution.id} className="rounded border border-neutral-200 bg-white p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{execution.provider} · {execution.operation}</span>
                      <Status value={execution.status} />
                      <span className="text-xs text-neutral-400">{execution.actionClass}</span>
                    </div>
                    <div className="mt-1 break-all text-xs text-neutral-600">
                      {execution.resourceType} · {execution.resourceId}
                    </div>
                    <div className="mt-1 grid gap-1 text-[11px] text-neutral-500 sm:grid-cols-2 xl:grid-cols-3">
                      <span>소스 {mono(execution.sourceSha, 12)} · 설정 버전 {execution.configRevisionNumber}</span>
                      <span>목표 설정 {mono(execution.desiredHash, 14)}</span>
                      <span>연결 확인값 {mono(execution.bindingHash, 14)}</span>
                      <span>계정 {execution.publicAccountId}</span>
                      <span>연결 계정 ID {execution.credentialPublicIdentity}</span>
                      <span>대상 리소스 ID {execution.expectedPublicIdentity ?? "—"}</span>
                      <span>{execution.logicalCredentialId} · 변경 차수 {execution.credentialGeneration}/{execution.policyGeneration}</span>
                      <span>{execution.adapterId} · {execution.capability}</span>
                      <span>결과 조회 계정 {execution.readbackLogicalCredentialId} · 변경 차수 {execution.readbackCredentialGeneration}/{execution.readbackPolicyGeneration}</span>
                      <span>결과 조회 계정 ID {execution.readbackCredentialPublicIdentity} · {execution.readbackCapability}</span>
                      <span>실행 {execution.attempts}/{execution.maxAttempts} · 결과 확인 {execution.readbackAttempts}/{execution.maxAttempts}</span>
                      <span>{dateTime(execution.updatedAt)}{execution.workerId ? ` · ${execution.workerId}` : ""}</span>
                    </div>
                    {execution.lastErrorCode && <div className="mt-2 text-xs text-red-700">{execution.lastErrorCode}</div>}
                  </div>
                  {execution.status === "WAITING_HUMAN_APPROVAL" ? (
                    <ProviderExecutionApprovalButton
                      appId={fleet.id}
                      executionId={execution.id}
                      generation={execution.leaseGeneration}
                      bindingHash={execution.bindingHash}
                    />
                  ) : (
                    <div className="text-right text-[11px] text-neutral-400">
                      실행 권한 차수 {execution.leaseGeneration}<br />
                      {execution.readbackRequiredAt ? `결과 확인 요청 ${dateTime(execution.readbackRequiredAt)}` : execution.approvedBy ? `승인 ${execution.approvedBy}` : ""}
                    </div>
                  )}
                </div>
              </article>
            ))}
            {fleet.providerExecutions.length === 0 && <Empty>마켓·서비스 실행 기록이 없습니다.</Empty>}
          </div>
        </Panel>
      </WorkspaceSection>

      <WorkspaceSection
        title="설정 버전"
        description="사람과 자동 작업에 같은 검증 기준을 적용합니다. 먼저 초안을 저장한 뒤 적용하며, 이미 적용된 설정은 덮어쓰지 않고 새 버전으로 보관합니다."
      >
        <FleetConfigEditor
          appId={fleet.id}
          activeRevision={activeConfig?.revision ?? 0}
          latestRevision={fleet.configRevisions[0]?.revision ?? 0}
          initialPayload={initialPayload}
          initialPayloadSource={initialPayloadSource}
          legacyActiveBlocked={Boolean(activeConfig) && !activePayload.success}
          shadowSourceSha={latestDiscovery?.sourceSha ?? null}
          drafts={drafts.map((draft) => ({
            revision: draft.revision,
            payloadHash: draft.payloadHash,
            createdBy: draft.createdBy,
            createdAt: dateTime(draft.createdAt),
            activatable: !draft.legacyConfigImport && configRevisionPayloadSchema.safeParse(draft.payload).success,
            activationLabel: draft.legacyConfigImport
              ? `기존 설정 가져오기 ${managementStatusLabel(draft.legacyConfigImport.status)} — 적용 불가`
              : configRevisionPayloadSchema.safeParse(draft.payload).success
                ? "설정 적용"
                : "현재 규격에 맞지 않는 초안",
          }))}
        />
      </WorkspaceSection>

      <WorkspaceSection
        title="기존 설정 가져오기·비교"
        description="어느 소스에서 가져왔는지와 현재 중앙 설정과의 비교 결과를 표시합니다. 원문은 저장하거나 표시하지 않으며 가져온 초안은 바로 적용할 수 없습니다. 전체 비교 2회 연속 일치, 대상 마켓 시험 빌드, 장애 복구 확인을 모두 통과해야 기존 파일을 삭제할 수 있습니다."
      >
        <Panel title="최근 가져오기 기록">
          <div className="space-y-3">
            {fleet.legacyConfigImports.map((legacyImport) => {
              const parsedReasonCodes = legacyConfigResolutionReasonCodeSchema.array().safeParse(legacyImport.reasonCodes);
              const latestResolution = fleet.legacyConfigResolutions.find((resolution) => (
                resolution.sourceSha === legacyImport.sourceSha
                && resolution.transformVersion === legacyImport.transformVersion
              ));
              const importResolution = fleet.legacyConfigResolutions.find((resolution) => (
                resolution.sourceImportId === legacyImport.id
              ));
              return (
              <article key={legacyImport.id} className="rounded border border-neutral-200 bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-medium text-neutral-800">{mono(legacyImport.sourceSha, 16)}</span>
                      <Status value={legacyImport.status} />
                      {legacyImport.configRevision && (
                        <span className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">
                          초안 버전 {legacyImport.configRevision.revision}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                      {legacyImport.sourceRef ?? "원본 참조 없음"} · {legacyImport.transformVersion} · {legacyImport.observedBy} · {dateTime(legacyImport.observedAt)}
                    </div>
                    <div className="mt-1 text-[11px] text-neutral-400">입력 확인값 {mono(legacyImport.inputDigest, 20)}</div>
                    {parsedReasonCodes.success && parsedReasonCodes.data.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {parsedReasonCodes.data.map((code) => (
                          <span key={code} className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] text-amber-900">{code}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
                    삭제 보류 · 전체 비교 2회와 복구·시험 빌드 결과 확인 필요
                  </span>
                </div>

                {importResolution && (
                  <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                    가져온 설정의 검토 버전 {importResolution.revision} · {importResolution.approvalKind} · {importResolution.createdBy} · {dateTime(importResolution.createdAt)} · 확인값 {mono(importResolution.resolutionDigest, 14)}
                  </div>
                )}
                {fleet.repoId !== null && activeConfig && parsedReasonCodes.success && parsedReasonCodes.data.length > 0 && (
                  <div className="mt-3">
                    <LegacyConfigResolutionButton
                      appId={fleet.id}
                      repoId={fleet.repoId.toString()}
                      sourceSha={legacyImport.sourceSha}
                      legacyImportId={legacyImport.id}
                      activeConfigRevision={activeConfig.revision}
                      expectedResolutionRevision={latestResolution?.revision ?? 0}
                      reasonCodes={parsedReasonCodes.data}
                      availableEvidenceKinds={availableLegacyEvidenceKinds}
                    />
                  </div>
                )}

                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[900px] text-left text-[11px]">
                    <thead className="border-b border-neutral-200 text-neutral-500">
                      <tr><th className="py-1.5 pr-3">원본</th><th className="pr-3">저장소</th><th className="pr-3">상태</th><th className="pr-3">파일 버전</th><th className="pr-3">내용 확인값</th><th>관측</th></tr>
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
                  {legacyImport.sources.length === 0 && <Empty>원본 정보가 없습니다.</Empty>}
                </div>

                <div className="mt-3 space-y-2">
                  {legacyImport.parityObservations.map((parity) => (
                    <details key={parity.id} className="rounded border border-neutral-200 px-3 py-2">
                      <summary className="cursor-pointer text-xs text-neutral-700">
                        <span className="mr-2 inline-block"><Status value={parity.status} /></span>
                        {parity.scope} · 비교 규격 {parity.contractVersion} · {dateTime(parity.observedAt)}
                      </summary>
                      <dl className="mt-2 grid gap-1 text-[11px] sm:grid-cols-2">
                        <Meta label="비교 설정" value={parity.configRevisionId ? mono(parity.configRevisionId, 16) : "없음"} />
                        <Meta label="관측자" value={parity.observedBy} />
                        <Meta label="기존 설정 확인값" value={mono(parity.legacyDigest, 16)} />
                        <Meta label="중앙 설정 확인값" value={mono(parity.centralDigest, 16)} />
                        <Meta label="검토 기록" value={mono(parity.legacyConfigResolutionId, 16)} />
                      </dl>
                      <pre className="mt-2 max-h-48 overflow-auto rounded bg-neutral-950 p-3 text-[11px] text-neutral-100">{jsonText(parity.diff ?? [])}</pre>
                    </details>
                  ))}
                  {legacyImport.parityObservations.length === 0 && <Empty>설정 비교 결과가 없습니다.</Empty>}
                </div>
              </article>
              );
            })}
            {fleet.legacyConfigImports.length === 0 && <Empty>기존 설정을 가져온 기록이 없습니다.</Empty>}
          </div>
        </Panel>
      </WorkspaceSection>

      <WorkspaceSection
        title="전체 앱 설정 비교"
        description="관리 중인 전체 앱의 소스와 설정 버전을 고정해 비교합니다. 같은 대상을 두 번 별도로 비교해 모두 일치해야 기존 설정 삭제를 위한 비교 조건을 충족합니다."
      >
        <Panel title="최근 앱별 비교 결과">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-xs">
              <thead className="border-b border-neutral-200 text-neutral-500">
                <tr>
                  <th className="py-2 pr-3">비교 실행</th><th className="pr-3">결과</th><th className="pr-3">대상 소스·설정</th><th className="pr-3">전체 앱</th><th>증거</th>
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
                      <div className="mt-1 text-[11px] text-neutral-500">{result.reasonCode ?? `원본 ${result.sourceCount}개`}</div>
                    </td>
                    <td className="pr-3 align-top font-mono text-[11px] text-neutral-500">
                      <div>소스 {mono(result.sourceSha, 12)}</div>
                      <div>설정 {mono(result.configRevisionId, 12)}</div>
                      <div>{result.scope} · {result.contractVersion}</div>
                    </td>
                    <td className="pr-3 align-top text-neutral-600">
                      <div><Status value={result.wave.status} /> · {result.wave.matchCount}/{result.wave.resultCount}</div>
                      <div className="mt-1">연속 {result.wave.consecutiveMatchCount}/2 · 설정 비교 조건 {result.wave.cleanupAllowed ? "충족" : "차단"}</div>
                    </td>
                    <td className="align-top font-mono text-[11px] text-neutral-500">
                      <div>대상 앱 {mono(result.wave.cohortDigest, 14)}</div>
                      <div>대상 버전 {mono(result.wave.vectorDigest, 14)}</div>
                      <div>확인 결과 {mono(result.wave.evidenceDigest, 14)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {fleet.fleetParityWaveResults.length === 0 && <Empty>전체 앱 비교 기록이 없습니다.</Empty>}
          </div>
        </Panel>
      </WorkspaceSection>

      <WorkspaceSection title="확인 기록·계정 연결" description="확인 기록은 덮어쓰지 않고 이력으로 남깁니다. 계정·키는 비밀값 없이 등록 ID와 공개 계정 정보만 표시합니다.">
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="소스 확인 기록">
            <ObservationList
              empty="소스 확인 기록이 없습니다."
              rows={fleet.discoveryObservations.map((row) => ({
                id: row.id,
                title: `${mono(row.sourceSha, 12)}${row.sourceRef ? ` · ${row.sourceRef}` : ""}`,
                subtitle: `${dateTime(row.observedAt)} · ${row.observedBy} · ${row.workflowProfile ?? "빌드 설정 미확인"}/${row.workflowPackageManager ?? "—"} @ ${row.workflowWorkingDirectory ?? "—"}`,
                payload: row.payload,
              }))}
            />
          </Panel>
          <Panel title="마켓·서비스 확인 기록">
            <ObservationList
              empty="마켓·서비스 확인 기록이 없습니다."
              rows={fleet.providerObservations.map((row) => ({
                id: row.id,
                title: `${row.provider} · ${row.resourceType} · ${row.resourceId}`,
                subtitle: `${dateTime(row.observedAt)} · ${row.observedBy}`,
                payload: row.payload,
              }))}
            />
          </Panel>
          <Panel title="GitHub 연동 권한">
            {githubInstallation?.parsed.success ? (
              <div className="space-y-3">
                <dl className="grid gap-1 text-xs sm:grid-cols-2">
                  <Meta label="조직" value={githubInstallation.parsed.data.attributes.accountLogin} />
                  <Meta label="설치 번호" value={githubInstallation.parsed.data.attributes.installationId} />
                  <Meta label="저장소 범위" value={githubInstallation.parsed.data.attributes.repositorySelection} />
                  <Meta label="중지" value={githubInstallation.parsed.data.attributes.suspended ? "예" : "아니오"} />
                  <Meta label="관측" value={dateTime(githubInstallation.observation.observedAt)} />
                </dl>
                <div className="space-y-1.5">
                  {Object.entries(githubInstallation.parsed.data.attributes.capabilities).map(([key, capability]) => (
                    <div key={key} className="rounded border border-neutral-200 px-2.5 py-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-neutral-800">{key}</span>
                        <Status value={capability.state} />
                      </div>
                      {capability.missing.length > 0 && (
                        <div className="mt-1 break-words text-[11px] text-neutral-500">
                          {capability.missing.join(" · ")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  권한 있음은 GitHub 연동 권한만 뜻합니다. 개별 작업의 실행 승인이나 변경 완료를 뜻하지 않습니다.
                </p>
              </div>
            ) : <Empty>GitHub 연동 권한을 확인한 기록이 없습니다.</Empty>}
          </Panel>
          <Panel title="공통 기능 적용 현황">
            {fleet.platformFleetBinding ? (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <Meta label="상태" value={managementStatusLabel(fleet.platformFleetBinding.state)} />
                <Meta label="적용 버전" value={fleet.platformFleetBinding.observedVersion} />
                <Meta label="적용 파일 확인값" value={mono(fleet.platformFleetBinding.observedDigest, 18)} />
                <Meta label="승인 버전" value={fleet.platformFleetBinding.approvedVersion} />
                <Meta label="승인 파일 확인값" value={mono(fleet.platformFleetBinding.approvedDigest, 18)} />
                <Meta label="구성 확인값" value={mono(fleet.platformFleetBinding.manifestDigest, 18)} />
                <Meta label="연동 규격" value={fleet.platformFleetBinding.contractRevision} />
                <Meta label="소스 버전" value={mono(fleet.platformFleetBinding.sourceSha, 12)} />
                <Meta label="예정 작업" value={fleet.platformFleetBinding.latestPlanKind} />
                <Meta
                  label="PR"
                  value={fleet.platformFleetBinding.pullRequestUrl
                    ? <a className="text-blue-700 underline" href={fleet.platformFleetBinding.pullRequestUrl}>#{fleet.platformFleetBinding.pullRequestNumber}</a>
                    : "—"}
                />
                <Meta
                  label="우선 처리 작업"
                  value={fleet.platformFleetBinding.issueUrl
                    ? <a className="text-blue-700 underline" href={fleet.platformFleetBinding.issueUrl}>#{fleet.platformFleetBinding.issueNumber}</a>
                    : "—"}
                />
                <Meta label="예외 만료" value={dateTime(fleet.platformFleetBinding.exceptionExpiresAt)} />
              </dl>
            ) : <Empty>공통 기능 연결 정보가 없습니다.</Empty>}
          </Panel>
          <Panel title="공통 기능 업데이트 이력">
            <div className="space-y-2">
              {fleet.platformFleetPlans.map((plan) => (
                <details key={plan.id} className="rounded border border-neutral-200 px-3 py-2">
                  <summary className="cursor-pointer text-sm text-neutral-800">
                    <span className="mr-2 font-medium">{plan.platformRelease.version} · {plan.kind}</span>
                    <Status value={plan.status} />
                  </summary>
                  <dl className="mt-2 grid gap-1 text-[11px] sm:grid-cols-2">
                    <Meta label="승인" value={plan.platformRelease.approval} />
                    <Meta label="변경 분류" value={plan.platformRelease.classification} />
                    <Meta label="소스 버전" value={mono(plan.sourceSha, 16)} />
                    <Meta label="구성 확인값" value={mono(plan.platformRelease.manifestDigest, 18)} />
                    <Meta label="목표 설정 확인값" value={mono(plan.desiredHash, 18)} />
                    <Meta label="연동 규격" value={mono(plan.platformRelease.contractRevision, 18)} />
                    <Meta label="소스 확인" value={mono(plan.discoveryObservationId, 16)} />
                    <Meta label="서비스 확인 기록" value={mono(plan.providerObservationId, 16)} />
                    <Meta label="예외 만료" value={dateTime(fleet.platformFleetBinding?.exceptionExpiresAt)} />
                    <Meta label="시도" value={String(plan.attempts)} />
                    <Meta label="갱신" value={dateTime(plan.updatedAt)} />
                  </dl>
                  {plan.githubUrl && (
                    <a className="mt-2 inline-block text-xs text-blue-700 underline" href={plan.githubUrl}>
                      GitHub #{plan.githubNumber}
                    </a>
                  )}
                  {plan.lastError && <p className="mt-2 text-xs text-red-700">{plan.lastError}</p>}
                </details>
              ))}
              {fleet.platformFleetPlans.length === 0 && <Empty>공통 기능 업데이트 계획이 없습니다.</Empty>}
            </div>
          </Panel>
          <Panel title="연결 계정·키 정보 — 조회 전용">
            <div className="space-y-2">
              {fleet.credentialBindings.map((binding) => (
                <div key={binding.id} className="rounded border border-neutral-200 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-neutral-800">{binding.provider} · {binding.capability}</span>
                    <Status value={binding.status} />
                  </div>
                  <div className="mt-1 grid gap-1 text-xs text-neutral-500 sm:grid-cols-2">
                    <span>등록 ID: <code>{binding.logicalCredentialId}</code></span>
                    <span>공개 계정 ID: {binding.publicIdentity ?? "—"}</span>
                    <span>지문: {mono(binding.fingerprint, 20)}</span>
                    <span>{binding.environment} · {binding.consumer}</span>
                    <span>변경 차수 {binding.credentialGeneration ?? "미등록"}/{binding.policyGeneration ?? "미등록"}</span>
                    <span>{binding.adapterId ?? "연결 도구 미등록"} · {binding.origin ?? "허용 주소 미등록"}</span>
                  </div>
                </div>
              ))}
              {fleet.credentialBindings.length === 0 && <Empty>등록된 계정·키 연결 정보가 없습니다.</Empty>}
            </div>
          </Panel>
        </div>
      </WorkspaceSection>

      <WorkspaceSection title="자동 작업" description="자동 작업을 만들고 즉시 또는 정기 실행하거나 일시중지·취소·재시도합니다. 실행에 필요한 임시 인증 정보는 이 화면에 저장하거나 표시하지 않습니다.">
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
        title="GitHub 작업 보드 동기화"
        description="우선순위, 앱, 작업 유형, 진행 단계, 담당 도구, 승인, 결과를 GitHub 작업 보드에 동기화합니다. 보드 표시를 바꾸는 것만으로 작업이 실행되지는 않습니다."
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
            {fleet.fleetProjectProjections.length === 0 && <Empty>작업 보드 동기화 기록이 없습니다.</Empty>}
          </div>
        </Panel>
      </WorkspaceSection>

      <WorkspaceSection
        title="직접 로그인 필요"
        description="어느 계정에 어떤 확인이 필요한지만 기록합니다. 비밀번호, 일회용 인증 코드, 로그인 정보, 복구 코드는 이 화면에서 입력하거나 조회하지 않습니다."
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
                  <div className="mt-1 text-xs text-neutral-600">{request.origin} · 계정 {request.publicAccountId}</div>
                  <div className="mt-1 text-xs text-neutral-500">{request.capability} · {request.reason}</div>
                  <div className="mt-1 text-[11px] text-neutral-400">요청 {dateTime(request.createdAt)} · {request.requestedBy}{request.runId ? ` · 작업 ${mono(request.runId, 10)}` : ""}</div>
                </div>
                {request.status === "HUMAN_REAUTH_REQUIRED" ? (
                  <TrustedLocalPendingButton appId={fleet.id} requestId={request.id} generation={request.generation} />
                ) : (
                  <div className="text-right text-xs text-amber-700">내 기기에서 로그인 대기<br />{dateTime(request.trustedLocalRequestedAt)}</div>
                )}
              </div>
            ))}
            {fleet.reauthRequests.length === 0 && <Empty>직접 로그인이 필요한 요청이 없습니다.</Empty>}
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

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return <div className="flex justify-between gap-3"><dt className="text-neutral-500">{label}</dt><dd className="text-right text-neutral-800">{value ?? "—"}</dd></div>;
}

function Empty({ children }: { children: ReactNode }) {
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
