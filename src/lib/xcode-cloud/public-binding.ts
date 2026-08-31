import type { Prisma } from "@prisma/client";

import { providerReadbackPayloadSchema } from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { recordProviderObservation } from "@/lib/control-plane/service";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { asc, asArray, type JsonApiResource } from "@/lib/app-store/asc-client";
import {
  matchesManualTagStartCondition,
  selectWorkflowForRepository,
  type WorkflowCandidate,
} from "@/lib/xcode-cloud/dispatch";

const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const STABLE_TAG_PROBE = "v0.0.0";

interface XcodeCloudSourceBinding {
  sourceSha: string;
  bundleId: string;
  appleTeamId: string;
  projectPath: string;
  scheme: string;
}

export interface XcodeCloudPublicBinding {
  publicAccountId: string;
  app: {
    id: string;
    name: string;
    bundleId: string;
    sku: string;
    primaryLocale: string;
  };
  product: {
    id: string;
    name: string;
    productType: string;
  };
  workflow: {
    id: string;
    name: string;
    repositoryId: string;
    repoFullName: string;
    scheme: string;
    platform: "IOS";
    buildDistributionAudience: "APP_STORE_ELIGIBLE";
  };
}

export class XcodeCloudPublicBindingError extends Error {
  constructor(
    readonly code:
      | "APPLICATION_ABSENT"
      | "APPLICATION_AMBIGUOUS"
      | "PRODUCT_ABSENT"
      | "PRODUCT_AMBIGUOUS"
      | "WORKFLOW_INVALID",
    message: string,
  ) {
    super(message);
  }
}

function stringAttribute(resource: JsonApiResource, name: string): string {
  const value = resource.attributes?.[name];
  return typeof value === "string" ? value : "";
}

function appForBundle(resources: JsonApiResource[], bundleId: string): JsonApiResource {
  const matches = resources.filter((resource) => stringAttribute(resource, "bundleId") === bundleId);
  if (matches.length === 0) {
    throw new XcodeCloudPublicBindingError(
      "APPLICATION_ABSENT",
      `App Store Connect application이 없습니다(bundleId=${bundleId}).`,
    );
  }
  if (matches.length !== 1) {
    throw new XcodeCloudPublicBindingError(
      "APPLICATION_AMBIGUOUS",
      `App Store Connect application이 ${matches.length}개입니다(bundleId=${bundleId}).`,
    );
  }
  return matches[0]!;
}

function productForApp(
  products: JsonApiResource[],
  includedApps: JsonApiResource[],
  appId: string,
  bundleId: string,
): JsonApiResource {
  const matches = products.filter((product) => {
    const relatedAppId = product.relationships?.app?.data?.id;
    if (relatedAppId === appId) return true;
    const included = includedApps.find((candidate) => candidate.id === relatedAppId);
    return stringAttribute(included ?? { id: "", type: "apps" }, "bundleId") === bundleId;
  });
  if (matches.length === 0) {
    throw new XcodeCloudPublicBindingError(
      "PRODUCT_ABSENT",
      `Xcode Cloud product가 없습니다(bundleId=${bundleId}).`,
    );
  }
  if (matches.length !== 1) {
    throw new XcodeCloudPublicBindingError(
      "PRODUCT_AMBIGUOUS",
      `Xcode Cloud product가 ${matches.length}개입니다(bundleId=${bundleId}).`,
    );
  }
  return matches[0]!;
}

function archiveScheme(actions: unknown): string | null {
  if (!Array.isArray(actions)) return null;
  const archive = actions.find((action) => (
    action !== null
    && typeof action === "object"
    && !Array.isArray(action)
    && (action as Record<string, unknown>).actionType === "ARCHIVE"
    && (action as Record<string, unknown>).platform === "IOS"
    && (action as Record<string, unknown>).buildDistributionAudience === "APP_STORE_ELIGIBLE"
  )) as Record<string, unknown> | undefined;
  return typeof archive?.scheme === "string" && archive.scheme ? archive.scheme : null;
}

/** provider JSON:API readback을 secret 없는 고정 공개 identity로 축소한다. */
export function selectXcodeCloudPublicBinding(input: {
  publicAccountId: string;
  bundleId: string;
  repoFullName: string;
  expectedScheme: string;
  applications: JsonApiResource[];
  products: JsonApiResource[];
  includedApps: JsonApiResource[];
  workflows: Array<WorkflowCandidate & { scheme: string | null }>;
}): XcodeCloudPublicBinding {
  const app = appForBundle(input.applications, input.bundleId);
  const product = productForApp(input.products, input.includedApps, app.id, input.bundleId);
  let selected: ReturnType<typeof selectWorkflowForRepository>;
  try {
    selected = selectWorkflowForRepository(input.workflows, input.repoFullName, STABLE_TAG_PROBE);
  } catch (error) {
    throw new XcodeCloudPublicBindingError(
      "WORKFLOW_INVALID",
      error instanceof Error ? error.message : "Xcode Cloud workflow identity가 유효하지 않습니다.",
    );
  }
  const workflow = input.workflows.find((candidate) => candidate.id === selected.workflowId)!;
  if (
    workflow.scheme !== input.expectedScheme
    || !matchesManualTagStartCondition(workflow.manualTagStartCondition, STABLE_TAG_PROBE)
  ) {
    throw new XcodeCloudPublicBindingError(
      "WORKFLOW_INVALID",
      `Xcode Cloud workflow scheme/tag 계약이 source와 다릅니다(repo=${input.repoFullName}).`,
    );
  }
  return {
    publicAccountId: input.publicAccountId,
    app: {
      id: app.id,
      name: stringAttribute(app, "name"),
      bundleId: stringAttribute(app, "bundleId"),
      sku: stringAttribute(app, "sku"),
      primaryLocale: stringAttribute(app, "primaryLocale"),
    },
    product: {
      id: product.id,
      name: stringAttribute(product, "name"),
      productType: stringAttribute(product, "productType"),
    },
    workflow: {
      id: workflow.id,
      name: workflow.name,
      repositoryId: selected.repositoryId,
      repoFullName: input.repoFullName,
      scheme: workflow.scheme,
      platform: "IOS",
      buildDistributionAudience: "APP_STORE_ELIGIBLE",
    },
  };
}

export async function readXcodeCloudPublicBinding(input: {
  bundleId: string;
  repoFullName: string;
  expectedScheme: string;
}): Promise<XcodeCloudPublicBinding> {
  const applications = await asc(
    `/v1/apps?filter[bundleId]=${encodeURIComponent(input.bundleId)}`
      + "&fields[apps]=name,bundleId,sku,primaryLocale&limit=10",
  );
  const products = await asc("/v1/ciProducts?include=app&limit=200");
  const app = appForBundle(asArray(applications.data), input.bundleId);
  const product = productForApp(
    asArray(products.data),
    products.included ?? [],
    app.id,
    input.bundleId,
  );
  const workflowDoc = await asc(
    `/v1/ciProducts/${encodeURIComponent(product.id)}/workflows?limit=200&`
      + "fields[ciWorkflows]=name,isEnabled,actions,manualTagStartCondition",
  );
  const workflows = await Promise.all(asArray(workflowDoc.data).map(async (workflow) => {
    let repoFullName: string | null = null;
    let repositoryId: string | null = null;
    try {
      const repositoryDoc = await asc(
        `/v1/ciWorkflows/${encodeURIComponent(workflow.id)}/repository`,
      );
      const repository = asArray(repositoryDoc.data)[0];
      repositoryId = repository?.id ?? null;
      const owner = repository?.attributes?.ownerName;
      const name = repository?.attributes?.repositoryName;
      if (typeof owner === "string" && typeof name === "string") {
        repoFullName = `${owner}/${name}`;
      }
    } catch {
      // 관계가 깨진 workflow는 fail-closed 선택 대상에서 제외한다.
    }
    const actions = workflow.attributes?.actions;
    return {
      id: workflow.id,
      name: stringAttribute(workflow, "name") || workflow.id,
      repoFullName,
      repositoryId,
      isEnabled: workflow.attributes?.isEnabled === true,
      actions,
      manualTagStartCondition: workflow.attributes?.manualTagStartCondition,
      scheme: archiveScheme(actions),
    };
  }));
  return selectXcodeCloudPublicBinding({
    publicAccountId: env.get("APP_STORE_CONNECT_ISSUER_ID"),
    bundleId: input.bundleId,
    repoFullName: input.repoFullName,
    expectedScheme: input.expectedScheme,
    applications: asArray(applications.data),
    products: asArray(products.data),
    includedApps: products.included ?? [],
    workflows,
  });
}

function sourceBinding(configuration: Prisma.JsonValue | null, sourceSha: string, bundleId: string | null): XcodeCloudSourceBinding | null {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) return null;
  const value = configuration as Record<string, unknown>;
  if (
    value.delivery !== "xcode-cloud"
    || typeof value.projectPath !== "string"
    || !value.projectPath.endsWith(".xcodeproj")
    || typeof value.scheme !== "string"
    || !value.scheme
    || typeof value.appleTeamId !== "string"
    || !APPLE_TEAM_ID.test(value.appleTeamId)
    || !bundleId
    || !BUNDLE_ID.test(bundleId)
    || !SOURCE_SHA.test(sourceSha)
  ) return null;
  return {
    sourceSha,
    bundleId,
    appleTeamId: value.appleTeamId,
    projectPath: value.projectPath,
    scheme: value.scheme,
  };
}

function occurrenceStart(now: Date): Date {
  const date = new Date(now);
  date.setUTCMinutes(0, 0, 0);
  return date;
}

function observationKey(input: {
  occurrence: Date;
  repoId: string;
  resourceType: string;
}): string {
  const digest = jsonDigest({
    contractVersion: "xcode-cloud-public-binding/v1",
    occurrence: input.occurrence.toISOString(),
    repoId: input.repoId,
    resourceType: input.resourceType,
  } as JsonValue);
  return `xcode-public:${digest}`;
}

function visiblePayload(publicIdentity: string, attributes: Record<string, unknown>) {
  return providerReadbackPayloadSchema.parse({
    schemaVersion: 1,
    visibility: "VISIBLE",
    state: "PRESENT",
    publicIdentity,
    attributes,
  });
}

function failurePayload(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const absent = error instanceof XcodeCloudPublicBindingError
    && ["APPLICATION_ABSENT", "PRODUCT_ABSENT"].includes(error.code);
  const forbidden = /App Store Connect API (?:401|403):/.test(message);
  return providerReadbackPayloadSchema.parse({
    schemaVersion: 1,
    visibility: absent ? "VISIBLE" : forbidden ? "FORBIDDEN" : "ERROR",
    state: absent ? "ABSENT" : "UNKNOWN",
    attributes: {
      errorCode: error instanceof XcodeCloudPublicBindingError
        ? error.code
        : forbidden ? "ASC_FORBIDDEN" : "ASC_READ_FAILED",
    },
  });
}

type RecordObservation = typeof recordProviderObservation;

async function recordReadyBinding(input: {
  repoId: bigint;
  source: XcodeCloudSourceBinding;
  binding: XcodeCloudPublicBinding;
  occurrence: Date;
  record: RecordObservation;
}): Promise<void> {
  const common = {
    repoId: input.repoId,
    observedAt: input.occurrence,
    observedBy: "scheduler:xcode-cloud-public-binding",
  };
  const source = {
    sourceSha: input.source.sourceSha,
    appleTeamId: input.source.appleTeamId,
    projectPath: input.source.projectPath,
    scheme: input.source.scheme,
  };
  await input.record({
    ...common,
    provider: "app-store",
    resourceType: "application",
    resourceId: input.binding.app.id,
    idempotencyKey: observationKey({
      occurrence: input.occurrence,
      repoId: input.repoId.toString(),
      resourceType: "application",
    }),
    payload: visiblePayload(`apps/${input.binding.app.id}`, {
      ...source,
      publicAccountId: input.binding.publicAccountId,
      publicAppId: input.binding.app.id,
      bundleId: input.binding.app.bundleId,
      name: input.binding.app.name,
      sku: input.binding.app.sku,
      primaryLocale: input.binding.app.primaryLocale,
    }),
    externalBinding: {
      bindingType: "application",
      externalId: input.binding.app.bundleId,
      publicIdentity: input.binding.app.bundleId,
      metadata: {
        publicAccountId: input.binding.publicAccountId,
        publicAppId: input.binding.app.id,
        appleTeamId: input.source.appleTeamId,
      },
    },
  });
  await input.record({
    ...common,
    provider: "xcode-cloud",
    resourceType: "product",
    resourceId: input.binding.product.id,
    idempotencyKey: observationKey({
      occurrence: input.occurrence,
      repoId: input.repoId.toString(),
      resourceType: "product",
    }),
    payload: visiblePayload(`ciProducts/${input.binding.product.id}`, {
      ...source,
      publicAccountId: input.binding.publicAccountId,
      publicAppId: input.binding.app.id,
      productName: input.binding.product.name,
      productType: input.binding.product.productType,
    }),
    externalBinding: {
      bindingType: "product",
      externalId: input.binding.product.id,
      publicIdentity: input.binding.product.name,
      metadata: {
        publicAppId: input.binding.app.id,
        bundleId: input.binding.app.bundleId,
      },
    },
  });
  await input.record({
    ...common,
    provider: "xcode-cloud",
    resourceType: "workflow",
    resourceId: input.binding.workflow.id,
    idempotencyKey: observationKey({
      occurrence: input.occurrence,
      repoId: input.repoId.toString(),
      resourceType: "workflow",
    }),
    payload: visiblePayload(`ciWorkflows/${input.binding.workflow.id}`, {
      ...source,
      publicAccountId: input.binding.publicAccountId,
      productId: input.binding.product.id,
      repositoryId: input.binding.workflow.repositoryId,
      repoFullName: input.binding.workflow.repoFullName,
      workflowName: input.binding.workflow.name,
      platform: input.binding.workflow.platform,
      buildDistributionAudience: input.binding.workflow.buildDistributionAudience,
      stableTagCondition: "v-prefix",
    }),
    externalBinding: {
      bindingType: "workflow",
      externalId: input.binding.workflow.id,
      publicIdentity: input.binding.workflow.name,
      metadata: {
        productId: input.binding.product.id,
        repositoryId: input.binding.workflow.repositoryId,
        repoFullName: input.binding.workflow.repoFullName,
        scheme: input.binding.workflow.scheme,
      },
    },
  });
}

export async function syncXcodeCloudPublicBindings(
  options: {
    now?: Date;
    read?: typeof readXcodeCloudPublicBinding;
    record?: RecordObservation;
  } = {},
): Promise<{
  checked: number;
  recorded: number;
  skipped: number;
  notReady: number;
  failed: number;
  failures: Array<{ repoFullName: string; code: string }>;
}> {
  const now = options.now ?? new Date();
  const occurrence = occurrenceStart(now);
  const read = options.read ?? readXcodeCloudPublicBinding;
  const record = options.record ?? recordProviderObservation;
  const repos = env.optional("XCODE_CLOUD_APP_STORE_REPOS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const apps = repos.length === 0 ? [] : await prisma.app.findMany({
    where: { repoFullName: { in: repos }, status: { not: "DEPRECATED" } },
    orderBy: { repoFullName: "asc" },
    select: {
      id: true,
      repoId: true,
      repoFullName: true,
      discoveryObservations: {
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { sourceSha: true },
      },
      buildTargets: {
        where: { targetKey: "ios", market: "app-store" },
        take: 2,
        select: { observedSha: true, bundleId: true, configuration: true },
      },
      providerObservations: {
        where: {
          provider: "xcode-cloud",
          resourceType: "workflow",
          observedAt: { gte: occurrence },
        },
        take: 1,
        select: { id: true },
      },
    },
  });
  let recorded = 0;
  let skipped = 0;
  let notReady = 0;
  let failed = 0;
  const failures: Array<{ repoFullName: string; code: string }> = [];
  for (const app of apps) {
    if (app.providerObservations.length > 0) {
      skipped++;
      continue;
    }
    const target = app.buildTargets.length === 1 ? app.buildTargets[0] : null;
    const latestSha = app.discoveryObservations[0]?.sourceSha ?? "";
    const source = target && target.observedSha === latestSha
      ? sourceBinding(target.configuration, target.observedSha, target.bundleId)
      : null;
    if (!app.repoId || !source) {
      notReady++;
      continue;
    }
    try {
      const binding = await read({
        bundleId: source.bundleId,
        repoFullName: app.repoFullName,
        expectedScheme: source.scheme,
      });
      await recordReadyBinding({
        repoId: app.repoId,
        source,
        binding,
        occurrence,
        record,
      });
      recorded++;
    } catch (error) {
      const payload = failurePayload(error);
      await record({
        repoId: app.repoId,
        provider: "app-store",
        resourceType: "xcode-cloud-binding",
        resourceId: source.bundleId,
        observedAt: occurrence,
        observedBy: "scheduler:xcode-cloud-public-binding",
        idempotencyKey: observationKey({
          occurrence,
          repoId: app.repoId.toString(),
          resourceType: "binding-error",
        }),
        payload,
      });
      failed++;
      failures.push({
        repoFullName: app.repoFullName,
        code: String(payload.attributes.errorCode),
      });
    }
  }
  return { checked: apps.length, recorded, skipped, notReady, failed, failures };
}
