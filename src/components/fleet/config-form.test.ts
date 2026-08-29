import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  draftFromPayload,
  emptyConfigDraft,
  payloadFromDraft,
} from "@/components/fleet/config-form";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";

const fullPayload = {
  schemaVersion: 1,
  markets: [
    { market: "google-play", enabled: true, locales: ["ko", "en-US"], releaseChannel: "internal" },
    { market: "app-store", enabled: false, locales: ["ko"] },
  ],
  localizations: [
    {
      market: "google-play",
      locale: "ko",
      displayName: "행복 농장",
      subtitle: "느긋한 농장 경영",
      description: "설명",
      keywords: ["농장", "힐링"],
    },
    { locale: "en-US", displayName: "Happy Farm" },
  ],
  assets: [
    {
      market: "google-play",
      kind: "icon",
      locale: "ko",
      objectKey: "assets/icon.png",
      checksum: "a".repeat(64),
    },
    { kind: "screenshot", objectKey: "assets/shot-1.png", checksum: "b".repeat(64) },
  ],
  build: {
    workflowBundleSha: "c".repeat(40),
    workflowBundleDigest: `sha256:${"d".repeat(64)}`,
    platformVersion: "1.4.0",
    minSdk: 24,
    targetSdk: 35,
  },
  support: {
    supportUrl: "https://seorilabs.dev/support",
    privacyPolicyUrl: "https://seorilabs.dev/privacy",
  },
  projectBlueprint: {
    schemaVersion: 1,
    organizationId: "123456789012",
    folderId: "987654321098",
    billingAccountId: "0A1B2C-3D4E5F-607182",
    project: { projectId: "seorilabs-happy-farm", projectNumber: "112233445566", region: "asia-northeast3" },
    apis: ["firestore.googleapis.com", "identitytoolkit.googleapis.com"],
    iam: [
      {
        role: "roles/datastore.user",
        logicalPrincipalId: "app/happy-farm/runtime",
        publicIdentity: "runtime@seorilabs-happy-farm.iam.gserviceaccount.com",
      },
    ],
    budget: { currencyCode: "KRW", monthlyAmount: 50000, alertThresholds: [0.5, 0.9] },
    firebase: {
      authProviders: ["anonymous", "google.com"],
      appCheckEnforcement: "ENFORCED",
      firestoreRulesChecksum: "d".repeat(64),
      firestoreIndexesChecksum: "e".repeat(64),
      storageRulesChecksum: "f".repeat(64),
      functions: { region: "asia-northeast3", runtime: "nodejs22" },
      apps: [
        { platform: "ANDROID", publicAppId: "1:1:android:1", packageId: "dev.seorilabs.happyfarm" },
        { platform: "WEB", publicAppId: "1:1:web:1" },
      ],
    },
    analytics: {
      ga4PropertyId: "445566778899",
      bigQueryProjectId: "seorilabs-happy-farm",
      datasetId: "analytics_445566778899",
      location: "US",
    },
    workspace: {
      groups: [{ email: "fleet@seorilabs.dev", role: "OPERATOR" }],
      domainWideDelegation: [
        { publicClientId: "102030405060", scopes: ["https://www.googleapis.com/auth/drive.readonly"] },
      ],
    },
    provisioners: {
      gcp: "shared/gcp/provisioner-session",
      firebase: "shared/gcp/firebase-automation",
      workspace: "shared/gcp/workspace-admin",
    },
  },
  complianceDrafts: [
    { market: "google-play", declaration: "data-safety", state: "DRAFT", draft: "수집 없음", evidenceRef: "docs/privacy.md" },
    { market: "app-store", declaration: "export-compliance", state: "DRAFT", draft: false },
    {
      market: "apps-in-toss",
      declaration: "content-rating",
      state: "DRAFT",
      draft: { rating: "ALL", violence: false, questions: 12, note: null },
    },
  ],
};

test("구조화 폼 draft는 strict 계약 payload를 손실 없이 왕복한다", () => {
  const parsed = configRevisionPayloadSchema.parse(fullPayload);
  const roundTripped = payloadFromDraft(draftFromPayload(parsed));
  assert.deepEqual(configRevisionPayloadSchema.parse(roundTripped), parsed);
});

test("record compliance draft의 빈 값은 null로 저장한다", () => {
  const draft = draftFromPayload(fullPayload);
  const row = draft.complianceDrafts[2];
  assert.equal(row.valueKind, "record");
  assert.match(row.record, /^rating=ALL\nviolence=false\nquestions=12\nnote=$/);
  const payload = payloadFromDraft(draft) as { complianceDrafts: Array<{ draft: Record<string, unknown> }> };
  assert.equal(payload.complianceDrafts[2].draft.note, null);
});

test("빈 draft도 서버 validator가 읽는 최소 payload를 만든다", () => {
  const payload = payloadFromDraft(emptyConfigDraft());
  assert.deepEqual(payload, { schemaVersion: 1, markets: [] });
  assert.equal(configRevisionPayloadSchema.safeParse(payload).success, true);
});

test("ProjectBlueprint 선언을 끄면 payload에서 통째로 빠진다", () => {
  const draft = draftFromPayload(fullPayload);
  assert.equal(draft.blueprint.declared, true);
  const without = payloadFromDraft({ ...draft, blueprint: { ...draft.blueprint, declared: false } });
  assert.equal("projectBlueprint" in without, false);
  assert.equal(configRevisionPayloadSchema.safeParse(without).success, true);
});

test("편집기는 raw JSON escape hatch와 클라이언트 이중 validator를 두지 않는다", () => {
  const editor = readFileSync(join(process.cwd(), "src/components/fleet/FleetConfigEditor.tsx"), "utf8");
  // 서버 action에 넘길 직렬화 한 번을 빼면 사용자가 JSON을 직접 입력하는 경로가 없다.
  assert.equal(editor.includes("JSON.parse"), false);
  assert.match(editor, /payloadFromDraft\(draft\)/);
  assert.doesNotMatch(editor, /from "zod"|control-plane\/contracts/);

  const form = readFileSync(join(process.cwd(), "src/components/fleet/config-form.ts"), "utf8");
  assert.doesNotMatch(form, /from "zod"|control-plane\/contracts/);
  // 비밀값 입력 필드를 만들지 않는다.
  assert.doesNotMatch(editor, /type="password"|apiKey|clientSecret|privateKey|accessToken/i);
});
