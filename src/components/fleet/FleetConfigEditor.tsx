"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { configOptionLabel, managementStatusLabel } from "@/lib/control-plane/presentation";

import {
  APP_CHECK_ENFORCEMENTS,
  ASSET_KINDS,
  BUDGET_CURRENCIES,
  COMPLIANCE_DECLARATIONS,
  FIREBASE_PLATFORMS,
  MARKETS,
  RELEASE_CHANNEL_BY_MARKET,
  WORKSPACE_ROLES,
  draftFromPayload,
  payloadFromDraft,
  type AssetDraft,
  type BlueprintDraft,
  type ComplianceDraftRow,
  type ConfigDraft,
  type DelegationDraft,
  type FirebaseAppDraft,
  type IamDraft,
  type LocalizationDraft,
  type MarketDraft,
  type WorkspaceGroupDraft,
} from "@/components/fleet/config-form";
import {
  activateFleetConfigRevisionAction,
  createFleetConfigDraftAction,
  importLegacyShadowAction,
  validateFleetConfigDraftAction,
} from "@/lib/actions/fleet-control-plane";

interface DraftSummary {
  revision: number;
  payloadHash: string;
  createdBy: string;
  createdAt: string;
  activatable: boolean;
  activationLabel: string;
}

const inputClass = "w-full rounded border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none";
const labelClass = "block text-[11px] font-medium uppercase tracking-wide text-neutral-500";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className={labelClass}>{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-neutral-400">{hint}</span>}
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      />
    </Field>
  );
}

function AreaField({
  label,
  value,
  onChange,
  hint,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  rows?: number;
}) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        value={value}
        rows={rows}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClass} font-mono`}
      />
    </Field>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  allowEmpty,
  hint,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  allowEmpty?: string;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      >
        {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
        {options.map((option) => <option key={option} value={option}>{configOptionLabel(option)}</option>)}
      </select>
    </Field>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded border border-neutral-200 p-3">
      <h4 className="text-sm font-semibold text-neutral-800">{title}</h4>
      <p className="mt-0.5 text-xs text-neutral-500">{description}</p>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function RowList<T>({
  rows,
  addLabel,
  onAdd,
  onRemove,
  render,
  empty,
}: {
  rows: T[];
  addLabel: string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  render: (row: T, index: number) => ReactNode;
  empty: string;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="rounded border border-neutral-200 bg-neutral-50 p-3">
          <div className="grid gap-3 sm:grid-cols-2">{render(row, index)}</div>
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="mt-2 rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
          >
            이 항목 삭제
          </button>
        </div>
      ))}
      {rows.length === 0 && <p className="text-xs text-neutral-400">{empty}</p>}
      <button
        type="button"
        onClick={onAdd}
        className="rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
      >
        {addLabel}
      </button>
    </div>
  );
}

interface StoreAssetUploadApiResponse {
  ok?: boolean;
  message?: string;
  issues?: Array<{ message?: string }>;
  receipt?: {
    objectKey?: string;
    checksum?: string;
    generation?: string;
    created?: boolean;
  };
}

function StoreAssetUploadField({
  appId,
  expectedLatestRevision,
  asset,
  disabled,
  onUploaded,
  onMessage,
  onError,
}: {
  appId: string;
  expectedLatestRevision: number;
  asset: AssetDraft;
  disabled: boolean;
  onUploaded: (receipt: { objectKey: string; checksum: string }) => void;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
}) {
  const binding = JSON.stringify({
    expectedLatestRevision,
    market: asset.market,
    locale: asset.locale,
    kind: asset.kind,
  });
  const [selection, setSelection] = useState<{
    file: File;
    requestId: string;
    binding: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const selectionMatches = selection?.binding === binding;

  async function upload() {
    if (!selection || !selectionMatches) return;
    setUploading(true);
    onError("");
    try {
      const formData = new FormData();
      formData.set("expectedLatestRevision", String(expectedLatestRevision));
      if (asset.market) formData.set("market", asset.market);
      formData.set("kind", asset.kind);
      if (asset.locale) formData.set("locale", asset.locale);
      formData.set("file", selection.file);
      const response = await fetch(`/api/platform/apps/${encodeURIComponent(appId)}/store-assets`, {
        method: "POST",
        headers: { "Idempotency-Key": `ui-store-asset:${selection.requestId}` },
        body: formData,
      });
      const result = await response.json().catch(() => ({})) as StoreAssetUploadApiResponse;
      const objectKey = result.receipt?.objectKey;
      const checksum = result.receipt?.checksum;
      if (!response.ok || !result.ok || typeof objectKey !== "string" || typeof checksum !== "string") {
        const issueMessage = result.issues?.map((issue) => issue.message).filter(Boolean).join(" ");
        throw new Error(result.message || issueMessage || "이미지 업로드를 처리하지 못했습니다.");
      }
      onUploaded({ objectKey, checksum });
      onMessage(
        `이미지를 업로드하고 저장된 파일이 원본과 일치하는지 확인했습니다 · 파일 버전 ${result.receipt?.generation ?? "확인됨"}`,
      );
      setSelection(null);
    } catch (uploadError) {
      onError(uploadError instanceof Error ? uploadError.message : "이미지 업로드를 처리하지 못했습니다.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2 rounded border border-neutral-200 bg-white p-3">
      <Field
        label="원본 이미지"
        hint="PNG/JPEG, 최대 20 MiB · 중앙 비공개 저장소에 저장한 뒤 원본과 일치하는지 확인합니다."
      >
        <input
          type="file"
          accept="image/png,image/jpeg"
          disabled={disabled || uploading}
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null;
            setSelection(file ? { file, requestId: crypto.randomUUID(), binding } : null);
          }}
          className={inputClass}
        />
      </Field>
      {!selectionMatches && selection && (
        <p className="text-xs text-amber-700">마켓·언어·종류가 변경되었습니다. 파일을 다시 선택하세요.</p>
      )}
      <button
        type="button"
        disabled={disabled || uploading || !selectionMatches}
        onClick={upload}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
      >
        {uploading ? "업로드·검증 중…" : "중앙 저장소에 업로드·검증"}
      </button>
    </div>
  );
}

export function FleetConfigEditor({
  appId,
  activeRevision,
  latestRevision,
  initialPayload,
  initialPayloadSource,
  legacyActiveBlocked,
  shadowSourceSha,
  drafts,
}: {
  appId: string;
  activeRevision: number;
  latestRevision: number;
  initialPayload: unknown;
  initialPayloadSource: "ACTIVE" | "LEGACY_SHADOW" | "EMPTY";
  legacyActiveBlocked: boolean;
  shadowSourceSha: string | null;
  drafts: DraftSummary[];
}) {
  const [draft, setDraft] = useState<ConfigDraft>(() => draftFromPayload(initialPayload));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const payloadText = useMemo(() => JSON.stringify(payloadFromDraft(draft)), [draft]);

  function patch(update: Partial<ConfigDraft>) {
    setDraft((current) => ({ ...current, ...update }));
  }
  function patchBlueprint(update: Partial<BlueprintDraft>) {
    setDraft((current) => ({ ...current, blueprint: { ...current.blueprint, ...update } }));
  }
  function replaceRow<K extends keyof ConfigDraft>(
    key: K,
    index: number,
    update: Partial<ConfigDraft[K] extends Array<infer R> ? R : never>,
  ) {
    setDraft((current) => {
      const rows = [...(current[key] as unknown as Array<Record<string, unknown>>)];
      rows[index] = { ...rows[index], ...update };
      return { ...current, [key]: rows } as ConfigDraft;
    });
  }
  function replaceBlueprintRow<K extends keyof BlueprintDraft>(
    key: K,
    index: number,
    update: Partial<BlueprintDraft[K] extends Array<infer R> ? R : never>,
  ) {
    setDraft((current) => {
      const rows = [...(current.blueprint[key] as unknown as Array<Record<string, unknown>>)];
      rows[index] = { ...rows[index], ...update };
      return { ...current, blueprint: { ...current.blueprint, [key]: rows } };
    });
  }

  function run(
    action: () => Promise<{
      ok: boolean;
      error?: string;
      revision?: number;
      status?: string;
      parityStatus?: string | null;
    }>,
    success: (result: { revision?: number; status?: string; parityStatus?: string | null }) => string,
    onSuccess?: () => void,
  ) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "요청을 처리하지 못했습니다.");
        return;
      }
      setMessage(success(result));
      onSuccess?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="mb-4 rounded border border-neutral-200 bg-neutral-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-neutral-800">기존 설정 가져오기·비교</div>
              <p className="mt-1 text-xs text-neutral-500">
                GitHub 기본 브랜치의 최신 소스를 다시 확인해 초안과 비교 결과만 기록합니다. 원문은 저장하지 않습니다.
              </p>
            </div>
            <button
              type="button"
              disabled={pending || !shadowSourceSha}
              onClick={() => shadowSourceSha && run(
                () => importLegacyShadowAction({
                  appId,
                  sourceSha: shadowSourceSha,
                  requestId: crypto.randomUUID(),
                }),
                (result) => result.status === "DRAFT_CREATED"
                  ? `기존 설정 가져오기 완료 · 초안 버전 ${result.revision} · 비교 결과 ${managementStatusLabel(result.parityStatus ?? "없음")}`
                  : result.status === "DRAFT_CREATED_WITH_INPUT"
                    ? `확인된 항목은 초안 버전 ${result.revision}에 채웠습니다. 남은 항목만 확인하면 됩니다.`
                    : result.status === "RESOLUTION_REUSED"
                      ? `기존 해소 근거를 재사용해 새 초안을 만들지 않았습니다. · 비교 결과 ${managementStatusLabel(result.parityStatus ?? "없음")}`
                    : `기존 설정 가져오기 ${managementStatusLabel(result.status ?? "완료")} · 소스 구조 확인이 필요합니다.`,
              )}
              className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              {shadowSourceSha ? "최신 소스에서 설정 가져오기" : "소스 확인 필요"}
            </button>
          </div>
        </div>

        <div className="text-sm font-semibold text-neutral-800">앱 운영 설정</div>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          마켓·스토어 소개·이미지, 빌드 버전, 지원 주소, 공개 계정 정보에 기반한 클라우드 구성과
          정책·신고 정보의 초안만 입력합니다. 비밀값 입력란은 없으며 법적 승인·심사 제출·공개 배포 정보는
          이 화면에서 저장하거나 적용할 수 없습니다. 모든 입력은 서버의 공통 기준으로 검증합니다.
        </p>
        {initialPayloadSource === "LEGACY_SHADOW" && (
          <p className="mt-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            최신 소스에서 가져온 기존 설정 중 검증을 통과한 항목을 불러왔습니다.
            아직 적용된 값이 아닙니다. 초안을 저장한 뒤 별도로 적용해야 합니다.
          </p>
        )}
        {legacyActiveBlocked && (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            기존에 적용된 설정은 현재 규격에 맞지 않아 편집 원본으로 복사하지 않았습니다. 서명된 기존 설정 조회는 유지되지만 다시 적용할 수 없습니다.
          </p>
        )}

        <div className="mt-4 space-y-4">
          <Section
            title="마켓 설정"
            description="마켓별 사용 여부, 지원 언어, 승인 전 테스트용 배포 채널을 설정합니다."
          >
            <RowList<MarketDraft>
              rows={draft.markets}
              empty="등록된 마켓이 없습니다."
              addLabel="마켓 추가"
              onAdd={() => patch({
                markets: [...draft.markets, { market: MARKETS[0], enabled: false, locales: "", releaseChannel: "" }],
              })}
              onRemove={(index) => patch({ markets: draft.markets.filter((_, item) => item !== index) })}
              render={(row, index) => (
                <>
                  <SelectField
                    label="마켓"
                    value={row.market}
                    options={MARKETS}
                    onChange={(value) => replaceRow("markets", index, {
                      market: value,
                      releaseChannel: row.enabled ? RELEASE_CHANNEL_BY_MARKET[value] ?? "" : "",
                    })}
                  />
                  <Field label="사용 여부">
                    <label className="flex items-center gap-2 text-sm text-neutral-700">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(event) => replaceRow("markets", index, {
                          enabled: event.target.checked,
                          releaseChannel: event.target.checked ? RELEASE_CHANNEL_BY_MARKET[row.market] ?? "" : "",
                        })}
                      />
                      이 마켓을 활성화
                    </label>
                  </Field>
                  <TextField
                    label="지원 언어"
                    value={row.locales}
                    hint="예: ko-KR, en-US · 쉼표 또는 공백으로 구분"
                    onChange={(value) => replaceRow("markets", index, { locales: value })}
                  />
                  <TextField
                    label="배포 채널"
                    value={row.releaseChannel}
                    hint="활성 마켓은 계약이 정한 값만 허용합니다."
                    onChange={(value) => replaceRow("markets", index, { releaseChannel: value })}
                  />
                </>
              )}
            />
          </Section>

          <Section
            title="스토어 소개"
            description="스토어에 표시할 소개 문구입니다. 마켓을 비우면 모든 마켓에 공통으로 적용합니다."
          >
            <RowList<LocalizationDraft>
              rows={draft.localizations}
              empty="등록된 스토어 소개가 없습니다."
              addLabel="스토어 소개 추가"
              onAdd={() => patch({
                localizations: [...draft.localizations, {
                  market: "", locale: "", displayName: "", subtitle: "", description: "", keywords: "",
                }],
              })}
              onRemove={(index) => patch({ localizations: draft.localizations.filter((_, item) => item !== index) })}
              render={(row, index) => (
                <>
                  <SelectField
                    label="마켓"
                    value={row.market}
                    options={MARKETS}
                    allowEmpty="전 마켓 공통"
                    onChange={(value) => replaceRow("localizations", index, { market: value })}
                  />
                  <TextField
                    label="언어"
                    value={row.locale}
                    onChange={(value) => replaceRow("localizations", index, { locale: value })}
                  />
                  <TextField
                    label="표시 이름"
                    value={row.displayName}
                    onChange={(value) => replaceRow("localizations", index, { displayName: value })}
                  />
                  <TextField
                    label="부제"
                    value={row.subtitle}
                    onChange={(value) => replaceRow("localizations", index, { subtitle: value })}
                  />
                  <TextField
                    label="검색어"
                    value={row.keywords}
                    hint="쉼표 구분, 최대 20개"
                    onChange={(value) => replaceRow("localizations", index, { keywords: value })}
                  />
                  <div className="sm:col-span-2">
                    <AreaField
                      label="상세 설명"
                      value={row.description}
                      rows={4}
                      onChange={(value) => replaceRow("localizations", index, { description: value })}
                    />
                  </div>
                </>
              )}
            />
          </Section>

          <Section
            title="스토어 이미지·파일"
            description="원본 이미지를 중앙 비공개 저장소에 올립니다. 저장된 파일을 다시 확인한 뒤 경로와 파일 확인값만 설정에 기록합니다."
          >
            <RowList<AssetDraft>
              rows={draft.assets}
              empty="등록된 이미지가 없습니다."
              addLabel="이미지 추가"
              onAdd={() => patch({
                assets: [...draft.assets, { market: "", kind: ASSET_KINDS[0], locale: "", objectKey: "", checksum: "" }],
              })}
              onRemove={(index) => patch({ assets: draft.assets.filter((_, item) => item !== index) })}
              render={(row, index) => (
                <>
                  <SelectField
                    label="마켓"
                    value={row.market}
                    options={MARKETS}
                    allowEmpty="전 마켓 공통"
                    onChange={(value) => replaceRow("assets", index, { market: value })}
                  />
                  <SelectField
                    label="종류"
                    value={row.kind}
                    options={ASSET_KINDS}
                    onChange={(value) => replaceRow("assets", index, { kind: value })}
                  />
                  <TextField
                    label="언어"
                    value={row.locale}
                    hint="비우면 모든 언어에 공통 적용"
                    onChange={(value) => replaceRow("assets", index, { locale: value })}
                  />
                  <div className="sm:col-span-2">
                    <StoreAssetUploadField
                      appId={appId}
                      expectedLatestRevision={latestRevision}
                      asset={row}
                      disabled={pending}
                      onUploaded={(receipt) => replaceRow("assets", index, receipt)}
                      onMessage={(nextMessage) => {
                        setError(null);
                        setMessage(nextMessage);
                      }}
                      onError={(nextError) => {
                        setMessage(null);
                        setError(nextError || null);
                      }}
                    />
                  </div>
                  <Field label="저장된 파일 경로">
                    <code className="block min-h-8 break-all rounded border border-neutral-200 bg-neutral-100 px-2 py-1.5 text-xs text-neutral-700">
                      {row.objectKey || "업로드 전"}
                    </code>
                  </Field>
                  <Field label="파일 확인값" hint="저장된 파일을 다시 읽어 확인한 SHA-256">
                    <code className="block min-h-8 break-all rounded border border-neutral-200 bg-neutral-100 px-2 py-1.5 text-xs text-neutral-700">
                      {row.checksum || "업로드 전"}
                    </code>
                  </Field>
                </>
              )}
            />
          </Section>

          <Section
            title="빌드 버전·지원 링크"
            description="출시 후보에 사용할 공통 빌드·공통 기능 버전과 고객 지원 주소입니다."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="공통 빌드 코드 버전"
                value={draft.buildWorkflowBundleSha}
                hint="40자리 SHA"
                onChange={(value) => patch({ buildWorkflowBundleSha: value })}
              />
              <TextField
                label="공통 빌드 설정 확인값"
                value={draft.buildWorkflowBundleDigest}
                hint="sha256: 접두사를 포함한 설정 확인값"
                onChange={(value) => patch({ buildWorkflowBundleDigest: value })}
              />
              <TextField
                label="공통 기능 버전"
                value={draft.buildPlatformVersion}
                hint="예: 1.2.3"
                onChange={(value) => patch({ buildPlatformVersion: value })}
              />
              <TextField
                label="최소 Android API 수준"
                value={draft.buildMinSdk}
                onChange={(value) => patch({ buildMinSdk: value })}
              />
              <TextField
                label="대상 Android API 수준"
                value={draft.buildTargetSdk}
                onChange={(value) => patch({ buildTargetSdk: value })}
              />
              <TextField
                label="고객 지원 주소"
                value={draft.supportUrl}
                hint="공개 HTTPS URL"
                onChange={(value) => patch({ supportUrl: value })}
              />
              <TextField
                label="개인정보 처리방침 주소"
                value={draft.privacyPolicyUrl}
                hint="공개 HTTPS URL"
                onChange={(value) => patch({ privacyPolicyUrl: value })}
              />
            </div>
            {draft.buildDependencyAuditException && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                <div className="font-semibold">서명된 의존성 검사 예외</div>
                <div className="mt-1 font-mono">
                  만료 {String(draft.buildDependencyAuditException.expiresAt ?? "미기록")}
                </div>
                <div className="mt-1">
                  코드 검사와 Android 시험 빌드에만 사용합니다. 이 편집기는 예외 정보를
                  수정하지 않고 다음 초안에 그대로 보존합니다.
                </div>
              </div>
            )}
          </Section>

          <Section
            title="정책·신고 정보 초안"
            description="사람 승인 전 초안만 보관합니다. 이 화면은 제출·승인 행위를 실행하지 않습니다."
          >
            <RowList<ComplianceDraftRow>
              rows={draft.complianceDrafts}
              empty="등록된 정책·신고 정보 초안이 없습니다."
              addLabel="정책·신고 정보 추가"
              onAdd={() => patch({
                complianceDrafts: [...draft.complianceDrafts, {
                  market: MARKETS[0],
                  declaration: COMPLIANCE_DECLARATIONS[0],
                  valueKind: "text",
                  text: "",
                  boolean: false,
                  record: "",
                  evidenceRef: "",
                }],
              })}
              onRemove={(index) => patch({
                complianceDrafts: draft.complianceDrafts.filter((_, item) => item !== index),
              })}
              render={(row, index) => (
                <>
                  <SelectField
                    label="마켓"
                    value={row.market}
                    options={MARKETS}
                    onChange={(value) => replaceRow("complianceDrafts", index, { market: value })}
                  />
                  <SelectField
                    label="신고 항목"
                    value={row.declaration}
                    options={COMPLIANCE_DECLARATIONS}
                    onChange={(value) => replaceRow("complianceDrafts", index, { declaration: value })}
                  />
                  <SelectField
                    label="입력 형식"
                    value={row.valueKind}
                    options={["text", "boolean", "record"]}
                    onChange={(value) => replaceRow("complianceDrafts", index, {
                      valueKind: value as ComplianceDraftRow["valueKind"],
                    })}
                  />
                  <TextField
                    label="근거 자료"
                    value={row.evidenceRef}
                    onChange={(value) => replaceRow("complianceDrafts", index, { evidenceRef: value })}
                  />
                  <div className="sm:col-span-2">
                    {row.valueKind === "boolean" ? (
                      <Field label="초안 내용">
                        <label className="flex items-center gap-2 text-sm text-neutral-700">
                          <input
                            type="checkbox"
                            checked={row.boolean}
                            onChange={(event) => replaceRow("complianceDrafts", index, {
                              boolean: event.target.checked,
                            })}
                          />
                          해당함
                        </label>
                      </Field>
                    ) : row.valueKind === "record" ? (
                      <AreaField
                        label="초안 내용"
                        value={row.record}
                        rows={4}
                        hint="한 줄에 항목=값을 입력합니다. true/false는 예/아니오, 숫자는 숫자, 빈 값은 미입력으로 저장합니다."
                        onChange={(value) => replaceRow("complianceDrafts", index, { record: value })}
                      />
                    ) : (
                      <AreaField
                        label="초안 내용"
                        value={row.text}
                        rows={4}
                        onChange={(value) => replaceRow("complianceDrafts", index, { text: value })}
                      />
                    )}
                  </div>
                </>
              )}
            />
          </Section>

          <Section
            title="클라우드 구성"
            description="GCP·Firebase·Workspace의 목표 설정입니다. 계정·키는 등록 ID로만 연결하며 비밀값을 입력하지 않습니다."
          >
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={draft.blueprint.declared}
                onChange={(event) => patchBlueprint({ declared: event.target.checked })}
              />
              이 설정 버전에 클라우드 구성 포함
            </label>
            {draft.blueprint.declared && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField label="조직 ID" value={draft.blueprint.organizationId} onChange={(value) => patchBlueprint({ organizationId: value })} />
                  <TextField label="폴더 ID" value={draft.blueprint.folderId} onChange={(value) => patchBlueprint({ folderId: value })} />
                  <TextField label="결제 계정 ID" value={draft.blueprint.billingAccountId} hint="XXXXXX-XXXXXX-XXXXXX" onChange={(value) => patchBlueprint({ billingAccountId: value })} />
                  <TextField label="프로젝트 ID" value={draft.blueprint.projectId} onChange={(value) => patchBlueprint({ projectId: value })} />
                  <TextField label="프로젝트 번호" value={draft.blueprint.projectNumber} hint="외부 서비스에서 확인하기 전에는 비웁니다." onChange={(value) => patchBlueprint({ projectNumber: value })} />
                  <TextField label="운영 지역" value={draft.blueprint.region} onChange={(value) => patchBlueprint({ region: value })} />
                </div>
                <AreaField label="사용할 Google API" value={draft.blueprint.apis} hint="예: firestore.googleapis.com · 쉼표 또는 공백으로 구분" onChange={(value) => patchBlueprint({ apis: value })} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <SelectField label="예산 통화" value={draft.blueprint.budgetCurrencyCode} options={BUDGET_CURRENCIES} onChange={(value) => patchBlueprint({ budgetCurrencyCode: value })} />
                  <TextField label="월 예산" value={draft.blueprint.budgetMonthlyAmount} onChange={(value) => patchBlueprint({ budgetMonthlyAmount: value })} />
                  <TextField label="예산 알림 기준" value={draft.blueprint.budgetAlertThresholds} hint="0보다 크고 2 이하인 비율" onChange={(value) => patchBlueprint({ budgetAlertThresholds: value })} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField label="로그인 제공 서비스" value={draft.blueprint.authProviders} onChange={(value) => patchBlueprint({ authProviders: value })} />
                  <SelectField label="앱 접근 검증" value={draft.blueprint.appCheckEnforcement} options={APP_CHECK_ENFORCEMENTS} onChange={(value) => patchBlueprint({ appCheckEnforcement: value })} />
                  <TextField label="데이터 접근 규칙 확인값" value={draft.blueprint.firestoreRulesChecksum} onChange={(value) => patchBlueprint({ firestoreRulesChecksum: value })} />
                  <TextField label="데이터 검색 설정 확인값" value={draft.blueprint.firestoreIndexesChecksum} onChange={(value) => patchBlueprint({ firestoreIndexesChecksum: value })} />
                  <TextField label="파일 접근 규칙 확인값" value={draft.blueprint.storageRulesChecksum} onChange={(value) => patchBlueprint({ storageRulesChecksum: value })} />
                  <TextField label="서버 함수 지역" value={draft.blueprint.functionsRegion} onChange={(value) => patchBlueprint({ functionsRegion: value })} />
                  <TextField label="서버 함수 실행 환경" value={draft.blueprint.functionsRuntime} hint="nodejsNN" onChange={(value) => patchBlueprint({ functionsRuntime: value })} />
                </div>
                <div>
                  <div className={labelClass}>Firebase 앱</div>
                  <div className="mt-1">
                    <RowList<FirebaseAppDraft>
                      rows={draft.blueprint.firebaseApps}
                      empty="등록된 Firebase 앱이 없습니다."
                      addLabel="Firebase 앱 추가"
                      onAdd={() => patchBlueprint({
                        firebaseApps: [...draft.blueprint.firebaseApps, {
                          platform: FIREBASE_PLATFORMS[0], publicAppId: "", packageId: "", bundleId: "", aitAppName: "",
                        }],
                      })}
                      onRemove={(index) => patchBlueprint({
                        firebaseApps: draft.blueprint.firebaseApps.filter((_, item) => item !== index),
                      })}
                      render={(row, index) => (
                        <>
                          <SelectField label="운영체제" value={row.platform} options={FIREBASE_PLATFORMS} onChange={(value) => replaceBlueprintRow("firebaseApps", index, { platform: value })} />
                          <TextField label="공개 앱 ID" value={row.publicAppId} onChange={(value) => replaceBlueprintRow("firebaseApps", index, { publicAppId: value })} />
                          <TextField label="Android 패키지 ID" value={row.packageId} hint="Android 전용" onChange={(value) => replaceBlueprintRow("firebaseApps", index, { packageId: value })} />
                          <TextField label="iOS 번들 ID" value={row.bundleId} hint="iOS 전용" onChange={(value) => replaceBlueprintRow("firebaseApps", index, { bundleId: value })} />
                          <TextField label="앱인토스 앱 이름" value={row.aitAppName} hint="앱인토스 전용" onChange={(value) => replaceBlueprintRow("firebaseApps", index, { aitAppName: value })} />
                        </>
                      )}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField label="GA4 속성 ID" value={draft.blueprint.ga4PropertyId} onChange={(value) => patchBlueprint({ ga4PropertyId: value })} />
                  <TextField label="분석 프로젝트 ID" value={draft.blueprint.bigQueryProjectId} onChange={(value) => patchBlueprint({ bigQueryProjectId: value })} />
                  <TextField label="분석 데이터셋 ID" value={draft.blueprint.datasetId} onChange={(value) => patchBlueprint({ datasetId: value })} />
                  <TextField label="분석 데이터 지역" value={draft.blueprint.analyticsLocation} hint="대문자 지역 코드, 예: US" onChange={(value) => patchBlueprint({ analyticsLocation: value })} />
                </div>
                <div>
                  <div className={labelClass}>계정 권한</div>
                  <div className="mt-1">
                    <RowList<IamDraft>
                      rows={draft.blueprint.iam}
                      empty="등록된 계정 권한이 없습니다."
                      addLabel="계정 권한 추가"
                      onAdd={() => patchBlueprint({
                        iam: [...draft.blueprint.iam, { role: "", logicalPrincipalId: "", publicIdentity: "" }],
                      })}
                      onRemove={(index) => patchBlueprint({ iam: draft.blueprint.iam.filter((_, item) => item !== index) })}
                      render={(row, index) => (
                        <>
                          <TextField label="권한" value={row.role} hint="roles/..." onChange={(value) => replaceBlueprintRow("iam", index, { role: value })} />
                          <TextField label="등록된 계정 ID" value={row.logicalPrincipalId} hint="shared/... 또는 app/..." onChange={(value) => replaceBlueprintRow("iam", index, { logicalPrincipalId: value })} />
                          <TextField label="공개 계정 ID" value={row.publicIdentity} onChange={(value) => replaceBlueprintRow("iam", index, { publicIdentity: value })} />
                        </>
                      )}
                    />
                  </div>
                </div>
                <div>
                  <div className={labelClass}>Workspace 그룹</div>
                  <div className="mt-1">
                    <RowList<WorkspaceGroupDraft>
                      rows={draft.blueprint.workspaceGroups}
                      empty="등록된 Workspace 그룹이 없습니다."
                      addLabel="Workspace 그룹 추가"
                      onAdd={() => patchBlueprint({
                        workspaceGroups: [...draft.blueprint.workspaceGroups, { email: "", role: WORKSPACE_ROLES[0] }],
                      })}
                      onRemove={(index) => patchBlueprint({
                        workspaceGroups: draft.blueprint.workspaceGroups.filter((_, item) => item !== index),
                      })}
                      render={(row, index) => (
                        <>
                          <TextField label="이메일" value={row.email} onChange={(value) => replaceBlueprintRow("workspaceGroups", index, { email: value })} />
                          <SelectField label="권한" value={row.role} options={WORKSPACE_ROLES} onChange={(value) => replaceBlueprintRow("workspaceGroups", index, { role: value })} />
                        </>
                      )}
                    />
                  </div>
                </div>
                <div>
                  <div className={labelClass}>Workspace 조직 권한 위임</div>
                  <div className="mt-1">
                    <RowList<DelegationDraft>
                      rows={draft.blueprint.delegations}
                      empty="등록된 조직 권한 위임이 없습니다."
                      addLabel="조직 권한 위임 추가"
                      onAdd={() => patchBlueprint({
                        delegations: [...draft.blueprint.delegations, { publicClientId: "", scopes: "" }],
                      })}
                      onRemove={(index) => patchBlueprint({
                        delegations: draft.blueprint.delegations.filter((_, item) => item !== index),
                      })}
                      render={(row, index) => (
                        <>
                          <TextField label="공개 클라이언트 ID" value={row.publicClientId} onChange={(value) => replaceBlueprintRow("delegations", index, { publicClientId: value })} />
                          <TextField label="허용 범위" value={row.scopes} hint="권한 범위 주소 · 공백 또는 쉼표로 구분" onChange={(value) => replaceBlueprintRow("delegations", index, { scopes: value })} />
                        </>
                      )}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <TextField label="GCP 설정 계정" value={draft.blueprint.provisionerGcp} hint="shared/... 만 허용" onChange={(value) => patchBlueprint({ provisionerGcp: value })} />
                  <TextField label="Firebase 설정 계정" value={draft.blueprint.provisionerFirebase} hint="shared/... 만 허용" onChange={(value) => patchBlueprint({ provisionerFirebase: value })} />
                  <TextField label="Workspace 설정 계정" value={draft.blueprint.provisionerWorkspace} hint="shared/... 만 허용" onChange={(value) => patchBlueprint({ provisionerWorkspace: value })} />
                </div>
              </div>
            )}
          </Section>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => run(
              () => validateFleetConfigDraftAction({
                appId,
                expectedLatestRevision: latestRevision,
                payloadText,
              }),
              () => "공통 검증 기준을 통과했습니다. 아직 저장되지 않았습니다.",
            )}
            className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            검증
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(
              () => createFleetConfigDraftAction({
                appId,
                expectedLatestRevision: latestRevision,
                payloadText,
                requestId: crypto.randomUUID(),
              }),
              (result) => `초안 버전 ${result.revision}을 저장했습니다.`,
            )}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            초안 저장
          </button>
          {pending && <span className="self-center text-xs text-neutral-500">처리 중…</span>}
        </div>
        {message && <p role="status" className="mt-2 text-sm text-emerald-700">{message}</p>}
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-neutral-800">적용 대기 초안</h3>
          <span className="text-xs text-neutral-500">현재 적용 설정 {activeRevision || "없음"}</span>
        </div>
        <div className="mt-3 divide-y divide-neutral-100 rounded border border-neutral-200">
          {drafts.map((item) => (
            <div key={item.revision} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
              <div>
                <div className="text-sm font-medium text-neutral-800">revision {item.revision}</div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  {item.createdBy} · {item.createdAt} · digest {item.payloadHash.slice(0, 12)}…
                </div>
                {!item.activatable && (
                  <div className="mt-1 text-xs font-medium text-amber-700">{item.activationLabel}</div>
                )}
              </div>
              <button
                type="button"
                disabled={pending || !item.activatable}
                onClick={() => run(
                  () => activateFleetConfigRevisionAction({
                    appId,
                    revision: item.revision,
                    expectedActiveRevision: activeRevision,
                    requestId: crypto.randomUUID(),
                  }),
                  (result) => `설정 버전 ${result.revision}을 적용했습니다.`,
                )}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {item.activationLabel}
              </button>
            </div>
          ))}
          {drafts.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-neutral-400">적용 대기 초안가 없습니다.</div>
          )}
        </div>
      </div>
    </div>
  );
}
