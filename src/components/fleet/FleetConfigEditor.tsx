"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";

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
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
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
        throw new Error(result.message || issueMessage || "StoreAsset upload를 처리하지 못했습니다.");
      }
      onUploaded({ objectKey, checksum });
      onMessage(
        `StoreAsset upload와 SHA-256 readback 검증을 완료했습니다 · generation ${result.receipt?.generation ?? "확인됨"}`,
      );
      setSelection(null);
    } catch (uploadError) {
      onError(uploadError instanceof Error ? uploadError.message : "StoreAsset upload를 처리하지 못했습니다.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2 rounded border border-neutral-200 bg-white p-3">
      <Field
        label="asset 원본"
        hint="PNG/JPEG, 최대 20 MiB · 중앙 private object storage에 저장 후 SHA-256을 다시 읽어 검증합니다."
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
        <p className="text-xs text-amber-700">market·locale·kind가 변경되었습니다. 파일을 다시 선택하세요.</p>
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
              <div className="text-sm font-semibold text-neutral-800">Legacy JSON shadow 관측</div>
              <p className="mt-1 text-xs text-neutral-500">
                최신 Discovery SHA를 GitHub default branch와 다시 대조해 원문 없이 DRAFT와 parity만 기록합니다.
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
                  ? `Shadow import 완료 · DRAFT revision ${result.revision} · parity ${result.parityStatus ?? "없음"}`
                  : result.status === "DRAFT_CREATED_WITH_INPUT"
                    ? `안전한 항목은 DRAFT revision ${result.revision}에 채웠습니다. 남은 항목만 확인하면 됩니다.`
                    : `Shadow import ${result.status ?? "완료"} · source 구조 확인이 필요합니다.`,
              )}
              className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              {shadowSourceSha ? "최신 SHA shadow import" : "Discovery 관측 필요"}
            </button>
          </div>
        </div>

        <div className="text-sm font-semibold text-neutral-800">비민감 desired state</div>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          market/localization/asset, build pin, support URL, 공개 identity 기반 ProjectBlueprint,
          사람 승인 전 compliance draft만 입력합니다. 비밀값 입력란은 없으며 법적 승인·심사 제출·공개 배포 필드는
          저장과 활성화가 모두 차단됩니다. 검증은 서버의 control-plane validator 한 곳에서만 수행합니다.
        </p>
        {initialPayloadSource === "LEGACY_SHADOW" && (
          <p className="mt-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            최신 exact-source shadow import에서 strict 비민감 validator를 통과한 payload를 편집 원본으로 불러왔습니다.
            이 값은 아직 ACTIVE가 아니며, 일반 DRAFT로 저장한 뒤 별도 활성화해야 합니다.
          </p>
        )}
        {legacyActiveBlocked && (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            기존 ACTIVE revision은 현재 strict 계약 밖의 payload라 편집 원본으로 복사하지 않았습니다. 서명 snapshot 조회는 유지되지만 재활성화할 수 없습니다.
          </p>
        )}

        <div className="mt-4 space-y-4">
          <Section
            title="MarketProfile"
            description="마켓별 활성화 여부, 지원 locale, 사람 승인 전 단계의 release channel을 선언합니다."
          >
            <RowList<MarketDraft>
              rows={draft.markets}
              empty="선언된 market이 없습니다."
              addLabel="market 추가"
              onAdd={() => patch({
                markets: [...draft.markets, { market: MARKETS[0], enabled: false, locales: "", releaseChannel: "" }],
              })}
              onRemove={(index) => patch({ markets: draft.markets.filter((_, item) => item !== index) })}
              render={(row, index) => (
                <>
                  <SelectField
                    label="market"
                    value={row.market}
                    options={MARKETS}
                    onChange={(value) => replaceRow("markets", index, {
                      market: value,
                      releaseChannel: row.enabled ? RELEASE_CHANNEL_BY_MARKET[value] ?? "" : "",
                    })}
                  />
                  <Field label="enabled">
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
                    label="locales"
                    value={row.locales}
                    hint="BCP-47, 쉼표 또는 공백 구분"
                    onChange={(value) => replaceRow("markets", index, { locales: value })}
                  />
                  <TextField
                    label="releaseChannel"
                    value={row.releaseChannel}
                    hint="활성 마켓은 계약이 정한 값만 허용합니다."
                    onChange={(value) => replaceRow("markets", index, { releaseChannel: value })}
                  />
                </>
              )}
            />
          </Section>

          <Section
            title="Localization"
            description="마켓 리스팅 텍스트입니다. market을 비우면 전 마켓 공통으로 적용합니다."
          >
            <RowList<LocalizationDraft>
              rows={draft.localizations}
              empty="선언된 localization이 없습니다."
              addLabel="localization 추가"
              onAdd={() => patch({
                localizations: [...draft.localizations, {
                  market: "", locale: "", displayName: "", subtitle: "", description: "", keywords: "",
                }],
              })}
              onRemove={(index) => patch({ localizations: draft.localizations.filter((_, item) => item !== index) })}
              render={(row, index) => (
                <>
                  <SelectField
                    label="market"
                    value={row.market}
                    options={MARKETS}
                    allowEmpty="전 마켓 공통"
                    onChange={(value) => replaceRow("localizations", index, { market: value })}
                  />
                  <TextField
                    label="locale"
                    value={row.locale}
                    onChange={(value) => replaceRow("localizations", index, { locale: value })}
                  />
                  <TextField
                    label="displayName"
                    value={row.displayName}
                    onChange={(value) => replaceRow("localizations", index, { displayName: value })}
                  />
                  <TextField
                    label="subtitle"
                    value={row.subtitle}
                    onChange={(value) => replaceRow("localizations", index, { subtitle: value })}
                  />
                  <TextField
                    label="keywords"
                    value={row.keywords}
                    hint="쉼표 구분, 최대 20개"
                    onChange={(value) => replaceRow("localizations", index, { keywords: value })}
                  />
                  <div className="sm:col-span-2">
                    <AreaField
                      label="description"
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
            title="StoreAsset"
            description="스토어 자산 원본을 중앙 private object storage에 올리고, 서버가 다시 읽어 검증한 object key와 SHA-256만 desired state에 고정합니다."
          >
            <RowList<AssetDraft>
              rows={draft.assets}
              empty="선언된 asset이 없습니다."
              addLabel="asset 추가"
              onAdd={() => patch({
                assets: [...draft.assets, { market: "", kind: ASSET_KINDS[0], locale: "", objectKey: "", checksum: "" }],
              })}
              onRemove={(index) => patch({ assets: draft.assets.filter((_, item) => item !== index) })}
              render={(row, index) => (
                <>
                  <SelectField
                    label="market"
                    value={row.market}
                    options={MARKETS}
                    allowEmpty="전 마켓 공통"
                    onChange={(value) => replaceRow("assets", index, { market: value })}
                  />
                  <SelectField
                    label="kind"
                    value={row.kind}
                    options={ASSET_KINDS}
                    onChange={(value) => replaceRow("assets", index, { kind: value })}
                  />
                  <TextField
                    label="locale"
                    value={row.locale}
                    hint="비우면 locale 공통"
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
                  <Field label="검증된 objectKey">
                    <code className="block min-h-8 break-all rounded border border-neutral-200 bg-neutral-100 px-2 py-1.5 text-xs text-neutral-700">
                      {row.objectKey || "업로드 전"}
                    </code>
                  </Field>
                  <Field label="검증된 checksum" hint="서버 upload 후 object readback SHA-256">
                    <code className="block min-h-8 break-all rounded border border-neutral-200 bg-neutral-100 px-2 py-1.5 text-xs text-neutral-700">
                      {row.checksum || "업로드 전"}
                    </code>
                  </Field>
                </>
              )}
            />
          </Section>

          <Section
            title="Build pin과 support URL"
            description="release candidate가 대조하는 WorkflowBundle SHA·payload digest·Platform version과 공개 지원 URL입니다."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="workflowBundleSha"
                value={draft.buildWorkflowBundleSha}
                hint="40자리 SHA"
                onChange={(value) => patch({ buildWorkflowBundleSha: value })}
              />
              <TextField
                label="workflowBundleDigest"
                value={draft.buildWorkflowBundleDigest}
                hint="sha256: 접두사를 포함한 payload digest"
                onChange={(value) => patch({ buildWorkflowBundleDigest: value })}
              />
              <TextField
                label="platformVersion"
                value={draft.buildPlatformVersion}
                hint="semver"
                onChange={(value) => patch({ buildPlatformVersion: value })}
              />
              <TextField
                label="minSdk"
                value={draft.buildMinSdk}
                onChange={(value) => patch({ buildMinSdk: value })}
              />
              <TextField
                label="targetSdk"
                value={draft.buildTargetSdk}
                onChange={(value) => patch({ buildTargetSdk: value })}
              />
              <TextField
                label="supportUrl"
                value={draft.supportUrl}
                hint="공개 HTTPS URL"
                onChange={(value) => patch({ supportUrl: value })}
              />
              <TextField
                label="privacyPolicyUrl"
                value={draft.privacyPolicyUrl}
                hint="공개 HTTPS URL"
                onChange={(value) => patch({ privacyPolicyUrl: value })}
              />
            </div>
            {draft.buildDependencyAuditException && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                <div className="font-semibold">서명된 dependency audit 예외</div>
                <div className="mt-1 font-mono">
                  expiresAt {String(draft.buildDependencyAuditException.expiresAt ?? "미기록")}
                </div>
                <div className="mt-1">
                  static check와 Android build-only 범위에서만 사용합니다. 이 구조화 편집기는 객체를
                  수정하지 않고 다음 DRAFT에 그대로 보존합니다.
                </div>
              </div>
            )}
          </Section>

          <Section
            title="Compliance draft"
            description="사람 승인 전 초안만 보관합니다. 이 화면은 제출·승인 행위를 실행하지 않습니다."
          >
            <RowList<ComplianceDraftRow>
              rows={draft.complianceDrafts}
              empty="선언된 compliance draft가 없습니다."
              addLabel="compliance draft 추가"
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
                    label="market"
                    value={row.market}
                    options={MARKETS}
                    onChange={(value) => replaceRow("complianceDrafts", index, { market: value })}
                  />
                  <SelectField
                    label="declaration"
                    value={row.declaration}
                    options={COMPLIANCE_DECLARATIONS}
                    onChange={(value) => replaceRow("complianceDrafts", index, { declaration: value })}
                  />
                  <SelectField
                    label="draft 형태"
                    value={row.valueKind}
                    options={["text", "boolean", "record"]}
                    onChange={(value) => replaceRow("complianceDrafts", index, {
                      valueKind: value as ComplianceDraftRow["valueKind"],
                    })}
                  />
                  <TextField
                    label="evidenceRef"
                    value={row.evidenceRef}
                    onChange={(value) => replaceRow("complianceDrafts", index, { evidenceRef: value })}
                  />
                  <div className="sm:col-span-2">
                    {row.valueKind === "boolean" ? (
                      <Field label="draft">
                        <label className="flex items-center gap-2 text-sm text-neutral-700">
                          <input
                            type="checkbox"
                            checked={row.boolean}
                            onChange={(event) => replaceRow("complianceDrafts", index, {
                              boolean: event.target.checked,
                            })}
                          />
                          선언 값 true
                        </label>
                      </Field>
                    ) : row.valueKind === "record" ? (
                      <AreaField
                        label="draft"
                        value={row.record}
                        rows={4}
                        hint="줄마다 key=value. true/false/숫자/빈 값은 각각 boolean, number, null로 저장합니다."
                        onChange={(value) => replaceRow("complianceDrafts", index, { record: value })}
                      />
                    ) : (
                      <AreaField
                        label="draft"
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
            title="ProjectBlueprint"
            description="GCP·Firebase·Workspace desired state입니다. credential은 logical ID로만 참조하며 비밀값 입력란이 없습니다."
          >
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={draft.blueprint.declared}
                onChange={(event) => patchBlueprint({ declared: event.target.checked })}
              />
              이 revision에 ProjectBlueprint를 선언
            </label>
            {draft.blueprint.declared && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField label="organizationId" value={draft.blueprint.organizationId} onChange={(value) => patchBlueprint({ organizationId: value })} />
                  <TextField label="folderId" value={draft.blueprint.folderId} onChange={(value) => patchBlueprint({ folderId: value })} />
                  <TextField label="billingAccountId" value={draft.blueprint.billingAccountId} hint="XXXXXX-XXXXXX-XXXXXX" onChange={(value) => patchBlueprint({ billingAccountId: value })} />
                  <TextField label="project.projectId" value={draft.blueprint.projectId} onChange={(value) => patchBlueprint({ projectId: value })} />
                  <TextField label="project.projectNumber" value={draft.blueprint.projectNumber} hint="readback 전에는 비웁니다." onChange={(value) => patchBlueprint({ projectNumber: value })} />
                  <TextField label="project.region" value={draft.blueprint.region} onChange={(value) => patchBlueprint({ region: value })} />
                </div>
                <AreaField label="apis" value={draft.blueprint.apis} hint="쉼표 또는 공백 구분 googleapis.com 목록" onChange={(value) => patchBlueprint({ apis: value })} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <SelectField label="budget.currencyCode" value={draft.blueprint.budgetCurrencyCode} options={BUDGET_CURRENCIES} onChange={(value) => patchBlueprint({ budgetCurrencyCode: value })} />
                  <TextField label="budget.monthlyAmount" value={draft.blueprint.budgetMonthlyAmount} onChange={(value) => patchBlueprint({ budgetMonthlyAmount: value })} />
                  <TextField label="budget.alertThresholds" value={draft.blueprint.budgetAlertThresholds} hint="0보다 크고 2 이하인 비율" onChange={(value) => patchBlueprint({ budgetAlertThresholds: value })} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField label="firebase.authProviders" value={draft.blueprint.authProviders} onChange={(value) => patchBlueprint({ authProviders: value })} />
                  <SelectField label="firebase.appCheckEnforcement" value={draft.blueprint.appCheckEnforcement} options={APP_CHECK_ENFORCEMENTS} onChange={(value) => patchBlueprint({ appCheckEnforcement: value })} />
                  <TextField label="firestoreRulesChecksum" value={draft.blueprint.firestoreRulesChecksum} onChange={(value) => patchBlueprint({ firestoreRulesChecksum: value })} />
                  <TextField label="firestoreIndexesChecksum" value={draft.blueprint.firestoreIndexesChecksum} onChange={(value) => patchBlueprint({ firestoreIndexesChecksum: value })} />
                  <TextField label="storageRulesChecksum" value={draft.blueprint.storageRulesChecksum} onChange={(value) => patchBlueprint({ storageRulesChecksum: value })} />
                  <TextField label="functions.region" value={draft.blueprint.functionsRegion} onChange={(value) => patchBlueprint({ functionsRegion: value })} />
                  <TextField label="functions.runtime" value={draft.blueprint.functionsRuntime} hint="nodejsNN" onChange={(value) => patchBlueprint({ functionsRuntime: value })} />
                </div>
                <div>
                  <div className={labelClass}>firebase.apps</div>
                  <div className="mt-1">
                    <RowList<FirebaseAppDraft>
                      rows={draft.blueprint.firebaseApps}
                      empty="선언된 Firebase app이 없습니다."
                      addLabel="Firebase app 추가"
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
                          <SelectField label="platform" value={row.platform} options={FIREBASE_PLATFORMS} onChange={(value) => replaceBlueprintRow("firebaseApps", index, { platform: value })} />
                          <TextField label="publicAppId" value={row.publicAppId} onChange={(value) => replaceBlueprintRow("firebaseApps", index, { publicAppId: value })} />
                          <TextField label="packageId" value={row.packageId} hint="ANDROID 전용" onChange={(value) => replaceBlueprintRow("firebaseApps", index, { packageId: value })} />
                          <TextField label="bundleId" value={row.bundleId} hint="IOS 전용" onChange={(value) => replaceBlueprintRow("firebaseApps", index, { bundleId: value })} />
                          <TextField label="aitAppName" value={row.aitAppName} hint="AIT 전용" onChange={(value) => replaceBlueprintRow("firebaseApps", index, { aitAppName: value })} />
                        </>
                      )}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField label="analytics.ga4PropertyId" value={draft.blueprint.ga4PropertyId} onChange={(value) => patchBlueprint({ ga4PropertyId: value })} />
                  <TextField label="analytics.bigQueryProjectId" value={draft.blueprint.bigQueryProjectId} onChange={(value) => patchBlueprint({ bigQueryProjectId: value })} />
                  <TextField label="analytics.datasetId" value={draft.blueprint.datasetId} onChange={(value) => patchBlueprint({ datasetId: value })} />
                  <TextField label="analytics.location" value={draft.blueprint.analyticsLocation} hint="대문자 location 코드" onChange={(value) => patchBlueprint({ analyticsLocation: value })} />
                </div>
                <div>
                  <div className={labelClass}>iam</div>
                  <div className="mt-1">
                    <RowList<IamDraft>
                      rows={draft.blueprint.iam}
                      empty="선언된 IAM binding이 없습니다."
                      addLabel="IAM binding 추가"
                      onAdd={() => patchBlueprint({
                        iam: [...draft.blueprint.iam, { role: "", logicalPrincipalId: "", publicIdentity: "" }],
                      })}
                      onRemove={(index) => patchBlueprint({ iam: draft.blueprint.iam.filter((_, item) => item !== index) })}
                      render={(row, index) => (
                        <>
                          <TextField label="role" value={row.role} hint="roles/..." onChange={(value) => replaceBlueprintRow("iam", index, { role: value })} />
                          <TextField label="logicalPrincipalId" value={row.logicalPrincipalId} hint="shared/... 또는 app/..." onChange={(value) => replaceBlueprintRow("iam", index, { logicalPrincipalId: value })} />
                          <TextField label="publicIdentity" value={row.publicIdentity} onChange={(value) => replaceBlueprintRow("iam", index, { publicIdentity: value })} />
                        </>
                      )}
                    />
                  </div>
                </div>
                <div>
                  <div className={labelClass}>workspace.groups</div>
                  <div className="mt-1">
                    <RowList<WorkspaceGroupDraft>
                      rows={draft.blueprint.workspaceGroups}
                      empty="선언된 Workspace group이 없습니다."
                      addLabel="Workspace group 추가"
                      onAdd={() => patchBlueprint({
                        workspaceGroups: [...draft.blueprint.workspaceGroups, { email: "", role: WORKSPACE_ROLES[0] }],
                      })}
                      onRemove={(index) => patchBlueprint({
                        workspaceGroups: draft.blueprint.workspaceGroups.filter((_, item) => item !== index),
                      })}
                      render={(row, index) => (
                        <>
                          <TextField label="email" value={row.email} onChange={(value) => replaceBlueprintRow("workspaceGroups", index, { email: value })} />
                          <SelectField label="role" value={row.role} options={WORKSPACE_ROLES} onChange={(value) => replaceBlueprintRow("workspaceGroups", index, { role: value })} />
                        </>
                      )}
                    />
                  </div>
                </div>
                <div>
                  <div className={labelClass}>workspace.domainWideDelegation</div>
                  <div className="mt-1">
                    <RowList<DelegationDraft>
                      rows={draft.blueprint.delegations}
                      empty="선언된 DWD가 없습니다."
                      addLabel="DWD 추가"
                      onAdd={() => patchBlueprint({
                        delegations: [...draft.blueprint.delegations, { publicClientId: "", scopes: "" }],
                      })}
                      onRemove={(index) => patchBlueprint({
                        delegations: draft.blueprint.delegations.filter((_, item) => item !== index),
                      })}
                      render={(row, index) => (
                        <>
                          <TextField label="publicClientId" value={row.publicClientId} onChange={(value) => replaceBlueprintRow("delegations", index, { publicClientId: value })} />
                          <TextField label="scopes" value={row.scopes} hint="공백 또는 쉼표 구분 scope URL" onChange={(value) => replaceBlueprintRow("delegations", index, { scopes: value })} />
                        </>
                      )}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <TextField label="provisioners.gcp" value={draft.blueprint.provisionerGcp} hint="shared/... 만 허용" onChange={(value) => patchBlueprint({ provisionerGcp: value })} />
                  <TextField label="provisioners.firebase" value={draft.blueprint.provisionerFirebase} hint="shared/... 만 허용" onChange={(value) => patchBlueprint({ provisionerFirebase: value })} />
                  <TextField label="provisioners.workspace" value={draft.blueprint.provisionerWorkspace} hint="shared/... 만 허용" onChange={(value) => patchBlueprint({ provisionerWorkspace: value })} />
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
              () => "동일한 control-plane validator를 통과했습니다. 아직 저장되지 않았습니다.",
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
              (result) => `DRAFT revision ${result.revision}을 생성했습니다.`,
            )}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            DRAFT 생성
          </button>
          {pending && <span className="self-center text-xs text-neutral-500">처리 중…</span>}
        </div>
        {message && <p role="status" className="mt-2 text-sm text-emerald-700">{message}</p>}
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-neutral-800">활성화 대기 DRAFT</h3>
          <span className="text-xs text-neutral-500">현재 ACTIVE revision {activeRevision || "없음"}</span>
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
                  (result) => `revision ${result.revision}을 ACTIVE로 전환했습니다.`,
                )}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {item.activationLabel}
              </button>
            </div>
          ))}
          {drafts.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-neutral-400">활성화 대기 DRAFT가 없습니다.</div>
          )}
        </div>
      </div>
    </div>
  );
}
