import assert from "node:assert/strict";
import test from "node:test";

import type { JsonApiResource } from "@/lib/app-store/asc-client";
import type { WorkflowCandidate } from "@/lib/xcode-cloud/dispatch";
import {
  selectXcodeCloudPublicBinding,
  XcodeCloudPublicBindingError,
} from "@/lib/xcode-cloud/public-binding";

const application: JsonApiResource = {
  id: "6786516830",
  type: "apps",
  attributes: {
    name: "내 도마뱀 키우기",
    bundleId: "com.seorilabs.lizardtycoon",
    sku: "lizard-tycoon-app",
    primaryLocale: "ko",
  },
};

const product: JsonApiResource = {
  id: "1F1C8BCC-7F10-4096-8563-6F375D5DB624",
  type: "ciProducts",
  attributes: { name: "LizardTerrarium", productType: "APP" },
  relationships: { app: { data: { id: application.id, type: "apps" } } },
};

const workflow: WorkflowCandidate & { scheme: string | null } = {
  id: "9AAF9F76-B518-42A9-9218-475CE2155345",
  name: "Lizard Tycoon Release",
  repoFullName: "seorilabs/lizard-tycoon",
  repositoryId: "ae0b4198-432d-42b8-bde8-3c2b84631655",
  isEnabled: true,
  actions: [{
    actionType: "ARCHIVE",
    platform: "IOS",
    buildDistributionAudience: "APP_STORE_ELIGIBLE",
    scheme: "LizardTerrarium",
  }],
  manualTagStartCondition: {
    source: {
      isAllMatch: false,
      patterns: [{ pattern: "v", isPrefix: true }],
    },
  },
  scheme: "LizardTerrarium",
};

function select(overrides: Partial<Parameters<typeof selectXcodeCloudPublicBinding>[0]> = {}) {
  return selectXcodeCloudPublicBinding({
    publicAccountId: "69a6de8f-0000-0000-0000-000000000000",
    bundleId: "com.seorilabs.lizardtycoon",
    repoFullName: "seorilabs/lizard-tycoon",
    expectedScheme: "LizardTerrarium",
    applications: [application],
    products: [product],
    includedApps: [application],
    workflows: [workflow],
    ...overrides,
  });
}

test("Lizard ASC app/product/workflow/repository 공개 identity를 하나의 binding으로 고정한다", () => {
  const binding = select();
  assert.deepEqual(binding.app, {
    id: "6786516830",
    name: "내 도마뱀 키우기",
    bundleId: "com.seorilabs.lizardtycoon",
    sku: "lizard-tycoon-app",
    primaryLocale: "ko",
  });
  assert.deepEqual(binding.product, {
    id: "1F1C8BCC-7F10-4096-8563-6F375D5DB624",
    name: "LizardTerrarium",
    productType: "APP",
  });
  assert.deepEqual(binding.workflow, {
    id: "9AAF9F76-B518-42A9-9218-475CE2155345",
    name: "Lizard Tycoon Release",
    repositoryId: "ae0b4198-432d-42b8-bde8-3c2b84631655",
    repoFullName: "seorilabs/lizard-tycoon",
    scheme: "LizardTerrarium",
    platform: "IOS",
    buildDistributionAudience: "APP_STORE_ELIGIBLE",
  });
});

test("ASC가 보이지만 app/product가 없는 상태는 ABSENT code로 분리한다", () => {
  assert.throws(
    () => select({ applications: [] }),
    (error) => error instanceof XcodeCloudPublicBindingError
      && error.code === "APPLICATION_ABSENT",
  );
  assert.throws(
    () => select({ products: [], includedApps: [] }),
    (error) => error instanceof XcodeCloudPublicBindingError
      && error.code === "PRODUCT_ABSENT",
  );
});

test("repo/scheme/manual stable tag 계약이 다르면 workflow binding을 만들지 않는다", () => {
  for (const changed of [
    { ...workflow, repoFullName: "seorilabs/other" },
    { ...workflow, scheme: "Other" },
    {
      ...workflow,
      manualTagStartCondition: {
        source: { isAllMatch: false, patterns: [{ pattern: "release/", isPrefix: true }] },
      },
    },
  ]) {
    assert.throws(
      () => select({ workflows: [changed] }),
      (error) => error instanceof XcodeCloudPublicBindingError
        && error.code === "WORKFLOW_INVALID",
    );
  }
});
