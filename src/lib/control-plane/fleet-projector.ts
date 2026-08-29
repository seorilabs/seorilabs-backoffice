import { Prisma } from "@prisma/client";

import { fleetProjectFieldsSchema } from "@/lib/control-plane/contracts";
import {
  fleetProjectionBindingDisposition,
} from "@/lib/control-plane/fleet-projector-binding";
import {
  reconcileFleetProjectBinding,
  resolveFleetProjectSource,
  type FleetProjectSourceApp,
  type FleetProjectSourceDisposition,
} from "@/lib/control-plane/fleet-project-binding";
import { upsertFleetProjectProjection } from "@/lib/control-plane/automation-service";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { getInstallationContext, type Octokit } from "@/lib/github/app";
import { prisma } from "@/lib/prisma";

const FIELD_NAMES = ["Priority", "App", "Kind", "Lifecycle", "Agent", "Approval", "Outcome"] as const;

interface ProjectField {
  __typename: string;
  id: string;
  name: string;
  dataType?: string;
  options?: Array<{ id: string; name: string }>;
}

interface ProjectItem {
  id: string;
  project: { id: string };
}

interface ProjectionBindingRow {
  id: string;
  status: string;
  projectNodeId: string;
  bindingRevision: number | null;
  app: FleetProjectSourceApp | null;
  source: FleetProjectSourceDisposition;
}

interface ProjectQuery {
  project: null | {
    id: string;
    fields: { nodes: Array<ProjectField | null> };
  };
  issue: null | {
    id: string;
    projectItems: { nodes: Array<ProjectItem | null> };
  };
}

interface ItemReadbackQuery {
  node: null | {
    fieldValues: {
      nodes: Array<null | {
        __typename: string;
        text?: string;
        name?: string;
        number?: number;
        field?: { name?: string } | null;
      }>;
    };
  };
}

const PROJECT_QUERY = `
  query FleetProjectContext($projectId: ID!, $issueId: ID!) {
    project: node(id: $projectId) {
      ... on ProjectV2 {
        id
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2Field { id name dataType }
            ... on ProjectV2SingleSelectField { id name dataType options { id name } }
          }
        }
      }
    }
    issue: node(id: $issueId) {
      ... on Issue {
        id
        projectItems(first: 20) { nodes { id project { id } } }
      }
    }
  }
`;

const ITEM_READBACK_QUERY = `
  query FleetProjectItemReadback($itemId: ID!) {
    node(id: $itemId) {
      ... on ProjectV2Item {
        fieldValues(first: 100) {
          nodes {
            __typename
            ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
            ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
            ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } }
          }
        }
      }
    }
  }
`;

async function readItemValues(octokit: Octokit, itemId: string): Promise<Record<string, string>> {
  const response = await octokit.graphql<ItemReadbackQuery>(ITEM_READBACK_QUERY, { itemId });
  const observed: Record<string, string> = {};
  for (const value of response.node?.fieldValues.nodes ?? []) {
    const name = value?.field?.name;
    if (!value || !name || !FIELD_NAMES.includes(name as typeof FIELD_NAMES[number])) continue;
    const raw = value.name ?? value.text ?? (value.number === undefined ? undefined : String(value.number));
    if (raw !== undefined) observed[name] = raw;
  }
  return observed;
}

function desiredByField(desired: ReturnType<typeof fleetProjectFieldsSchema.parse>): Record<string, string | null> {
  return {
    Priority: desired.priority,
    App: desired.app,
    Kind: desired.kind,
    Lifecycle: desired.lifecycle,
    Agent: desired.agent,
    Approval: desired.approval,
    Outcome: desired.outcome,
  };
}

function matchesDesired(observed: Record<string, string>, desired: Record<string, string | null>): boolean {
  return Object.entries(desired).every(([name, value]) => (
    value === null ? observed[name] === undefined : observed[name] === value
  ));
}

async function loadProjectionBinding(projectionId: string): Promise<ProjectionBindingRow | null> {
  const row = await prisma.fleetProjectProjection.findUnique({
    where: { id: projectionId },
    select: {
      id: true,
      status: true,
      projectNodeId: true,
      bindingRevision: true,
      app: { select: { id: true, status: true, repoId: true, repoFullName: true } },
    },
  });
  if (!row) return null;
  const source = row.app
    ? await resolveFleetProjectSource(row.app)
    : { kind: "INELIGIBLE" as const, reason: "Projection app이 삭제되었습니다." };
  return { ...row, source };
}

async function reconcileProjectionBinding(row: ProjectionBindingRow) {
  const disposition = fleetProjectionBindingDisposition(row);
  if (disposition.kind === "CURRENT") return disposition;
  const reconciled = await prisma.fleetProjectProjection.updateMany({
    where: {
      id: row.id,
      status: row.status,
      projectNodeId: row.projectNodeId,
      bindingRevision: row.bindingRevision,
    },
    data: { status: disposition.kind, lastError: disposition.reason },
  });
  if (reconciled.count !== 1) {
    const latest = await loadProjectionBinding(row.id);
    if (!latest) {
      return { kind: "SUPERSEDED" as const, reason: "Project projection이 삭제되어 적용을 중단했습니다." };
    }
    const latestDisposition = fleetProjectionBindingDisposition(latest);
    if (latestDisposition.kind === "CURRENT" || latest.status === latestDisposition.kind) {
      return latestDisposition;
    }
    throw new ControlPlaneError("Project projection binding reconciliation CAS에 실패했습니다.", 409, "PROJECTION_BINDING_CAS_FAILED");
  }
  return disposition;
}

async function reconcileCurrentProjectionBinding(projectionId: string) {
  const row = await loadProjectionBinding(projectionId);
  if (!row) {
    throw new ControlPlaneError("Project projection을 찾을 수 없습니다.", 404, "PROJECTION_NOT_FOUND");
  }
  return reconcileProjectionBinding(row);
}

async function validateClaimedProjectionBinding(projectionId: string): Promise<boolean> {
  const row = await loadProjectionBinding(projectionId);
  if (!row) return false;
  const disposition = await reconcileProjectionBinding(row);
  return row.status === "PROCESSING" && disposition.kind === "CURRENT";
}

async function ensureProjectItem(
  octokit: Octokit,
  projectId: string,
  issueId: string,
  existing: ProjectItem | undefined,
): Promise<string> {
  if (existing) return existing.id;
  const response = await octokit.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(`
    mutation AddFleetProjectItem($projectId: ID!, $issueId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $issueId }) { item { id } }
    }
  `, { projectId, issueId });
  return response.addProjectV2ItemById.item.id;
}

async function updateField(input: {
  octokit: Octokit;
  projectId: string;
  itemId: string;
  field: ProjectField;
  value: string;
}): Promise<void> {
  let fieldValue: { singleSelectOptionId: string } | { text: string } | { number: number };
  if (input.field.__typename === "ProjectV2SingleSelectField") {
    const option = input.field.options?.find((candidate) => candidate.name.toLowerCase() === input.value.toLowerCase());
    if (!option) {
      throw new ControlPlaneError(`${input.field.name} option '${input.value}'이 Fleet Project에 없습니다.`, 409, "PROJECT_OPTION_MISSING");
    }
    fieldValue = { singleSelectOptionId: option.id };
  } else if (input.field.dataType === "NUMBER") {
    const number = Number(input.value.replace(/^P/i, ""));
    if (!Number.isFinite(number)) throw new ControlPlaneError("Project number field 값이 올바르지 않습니다.", 409, "PROJECT_VALUE_INVALID");
    fieldValue = { number };
  } else if (input.field.dataType === "TEXT") {
    fieldValue = { text: input.value };
  } else {
    throw new ControlPlaneError(`${input.field.name} field type을 지원하지 않습니다.`, 409, "PROJECT_FIELD_UNSUPPORTED");
  }
  await input.octokit.graphql(`
    mutation UpdateFleetProjectField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) {
        projectV2Item { id }
      }
    }
  `, {
    projectId: input.projectId,
    itemId: input.itemId,
    fieldId: input.field.id,
    value: fieldValue,
  });
}

async function clearField(input: {
  octokit: Octokit;
  projectId: string;
  itemId: string;
  fieldId: string;
}): Promise<void> {
  await input.octokit.graphql(`
    mutation ClearFleetProjectField($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) {
        projectV2Item { id }
      }
    }
  `, {
    projectId: input.projectId,
    itemId: input.itemId,
    fieldId: input.fieldId,
  });
}

async function applyFleetProjectProjection(
  projectionId: string,
) {
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const staleAppliedBefore = new Date(Date.now() - 6 * 60 * 60_000);
  const claimed = await prisma.fleetProjectProjection.updateMany({
    where: {
      id: projectionId,
      OR: [
        { status: "PENDING" },
        { status: { in: ["FAILED", "READBACK_REQUIRED"] }, updatedAt: { lte: staleBefore } },
        { status: "PROCESSING", updatedAt: { lte: staleBefore } },
        { status: "APPLIED", updatedAt: { lte: staleAppliedBefore } },
      ],
    },
    data: { status: "PROCESSING", attempts: { increment: 1 }, lastError: null },
  });
  if (claimed.count !== 1) return { applied: false, skipped: true };
  const projection = await prisma.fleetProjectProjection.findUnique({
    where: { id: projectionId },
  });
  if (!projection) throw new ControlPlaneError("Project projection을 찾을 수 없습니다.", 404, "PROJECTION_NOT_FOUND");
  const bindingRow = await loadProjectionBinding(projection.id);
  if (!bindingRow) throw new ControlPlaneError("Project projection을 찾을 수 없습니다.", 404, "PROJECTION_NOT_FOUND");
  const initialBinding = await reconcileProjectionBinding(bindingRow);
  if (initialBinding.kind !== "CURRENT") {
    return { applied: false, skipped: true };
  }
  try {
    let installationContext: Awaited<ReturnType<typeof getInstallationContext>>;
    try {
      // Admin endpoint가 직전에 fresh installation readback을 완료해 같은 context를 cache한다.
      // issue마다 새 installation token을 만들지 않고, 동일 run 안의 검증된 context만 재사용한다.
      installationContext = await getInstallationContext();
    } catch (error) {
      await reconcileFleetProjectBinding({
        getInstallationContext: async () => { throw error; },
        now: () => new Date(),
      });
      await reconcileCurrentProjectionBinding(projection.id);
      return { applied: false, skipped: true };
    }
    const bindingReadback = await reconcileFleetProjectBinding({
      getInstallationContext: async () => installationContext,
      now: () => new Date(),
    });
    if (bindingReadback.gate !== "VERIFIED") {
      await reconcileCurrentProjectionBinding(projection.id);
      return { applied: false, skipped: true };
    }
    const client = installationContext.octokit;
    const desired = fleetProjectFieldsSchema.parse(projection.desired);
    const desiredFields = desiredByField(desired);
    const projectContext = await client.graphql<ProjectQuery>(PROJECT_QUERY, {
      projectId: projection.projectNodeId,
      issueId: projection.issueNodeId,
    });
    if (!projectContext.project || !projectContext.issue) {
      throw new ControlPlaneError("Project 또는 Issue node를 읽을 수 없습니다.", 409, "PROJECT_READBACK_MISSING");
    }
    const fields = new Map(
      projectContext.project.fields.nodes
        .filter((field): field is ProjectField => Boolean(field?.id && field.name))
        .map((field) => [field.name, field]),
    );
    for (const name of FIELD_NAMES) {
      if (!fields.has(name)) throw new ControlPlaneError(`Fleet Project field '${name}'이 없습니다.`, 409, "PROJECT_FIELD_MISSING");
    }
    if (!await validateClaimedProjectionBinding(projection.id)) return { applied: false, skipped: true };
    const itemId = await ensureProjectItem(
      client,
      projection.projectNodeId,
      projection.issueNodeId,
      projectContext.issue.projectItems.nodes.find((item): item is ProjectItem => item?.project.id === projection.projectNodeId),
    );
    const before = await readItemValues(client, itemId);
    if (!matchesDesired(before, desiredFields)) {
      for (const [name, value] of Object.entries(desiredFields)) {
        if (value === null && before[name] !== undefined) {
          if (!await validateClaimedProjectionBinding(projection.id)) return { applied: false, skipped: true };
          await clearField({
            octokit: client,
            projectId: projection.projectNodeId,
            itemId,
            fieldId: fields.get(name)!.id,
          });
        } else if (value !== null && before[name] !== value) {
          if (!await validateClaimedProjectionBinding(projection.id)) return { applied: false, skipped: true };
          await updateField({
            octokit: client,
            projectId: projection.projectNodeId,
            itemId,
            field: fields.get(name)!,
            value,
          });
        }
      }
    }
    const observed = await readItemValues(client, itemId);
    if (!matchesDesired(observed, desiredFields)) {
      throw new ControlPlaneError("Project write 후 readback이 desired state와 다릅니다.", 409, "PROJECT_READBACK_MISMATCH");
    }
    const completionBinding = await reconcileCurrentProjectionBinding(projection.id);
    if (completionBinding.kind !== "CURRENT") return { applied: false, skipped: true };
    const completed = await prisma.fleetProjectProjection.updateMany({
      where: {
        id: projection.id,
        status: "PROCESSING",
        projectNodeId: projection.projectNodeId,
        bindingRevision: projection.bindingRevision,
      },
      data: { status: "APPLIED", observed, appliedAt: new Date(), lastError: null },
    });
    if (completed.count !== 1) {
      const latestBinding = await reconcileCurrentProjectionBinding(projection.id);
      if (latestBinding.kind !== "CURRENT") return { applied: false, skipped: true };
      throw new ControlPlaneError("Project projection completion CAS에 실패했습니다.", 409, "PROJECTION_CAS_FAILED");
    }
    return { applied: true, skipped: false };
  } catch (error) {
    const failureBinding = await loadProjectionBinding(projection.id);
    if (failureBinding) {
      const disposition = await reconcileProjectionBinding(failureBinding);
      if (disposition.kind !== "CURRENT") return { applied: false, skipped: true };
    }
    await prisma.fleetProjectProjection.updateMany({
      where: { id: projection.id, status: "PROCESSING" },
      data: {
        status: "READBACK_REQUIRED",
        lastError: error instanceof Error ? error.message.slice(0, 1_000) : "Project projection failed",
        observed: Prisma.DbNull,
      },
    });
    throw error;
  }
}

/**
 * 정기 scheduler CronJob과 배포 catch-up Job이 같은 endpoint를 통해 이 drain을 호출한다.
 * 중복 webhook·중복 schedule에도 claim CAS가 한 projection을 한 번만 적용한다.
 * Fleet Project가 아직 설정되지 않은 row는 추측하지 않고 `NEEDS_INPUT`으로 닫아 fail-closed한다.
 */
async function drainFleetProjectProjections(limit = 20) {
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const staleAppliedBefore = new Date(Date.now() - 6 * 60 * 60_000);
  const rows = await prisma.fleetProjectProjection.findMany({
    where: {
      OR: [
        { status: "PENDING" },
        { status: { in: ["FAILED", "READBACK_REQUIRED"] }, updatedAt: { lte: staleBefore } },
        { status: "PROCESSING", updatedAt: { lte: staleBefore } },
        { status: "APPLIED", updatedAt: { lte: staleAppliedBefore } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
    select: { id: true },
  });
  let applied = 0;
  let failed = 0;
  let needsInput = 0;
  let superseded = 0;
  for (const candidate of rows) {
    try {
      const row = await loadProjectionBinding(candidate.id);
      if (!row) {
        superseded += 1;
        continue;
      }
      const binding = await reconcileProjectionBinding(row);
      if (binding.kind === "NEEDS_INPUT") {
        needsInput += 1;
        continue;
      }
      if (binding.kind === "READBACK_REQUIRED") {
        failed += 1;
        continue;
      }
      if (binding.kind !== "CURRENT") {
        superseded += 1;
        continue;
      }
      const result = await applyFleetProjectProjection(row.id);
      if (result.applied) applied += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: rows.length, applied, failed, needsInput, superseded };
}

/**
 * 중앙 binding activation 직후에도 기존 ACTIVE PRODUCT_APP Issue가 빠지지 않도록
 * 현재 mirror 전체를 source resolver로 재판정한다. resolver가 exact PRODUCT_APP가
 * 아닌 앱의 과거 projection을 SUPERSEDED로 닫는다.
 */
export async function reconcileFleetProjectProjectionSources() {
  const issues = await prisma.issueMirror.findMany({
    where: { app: { is: { status: "ACTIVE" } } },
    orderBy: [{ repoFullName: "asc" }, { number: "asc" }],
    select: { repoFullName: true, number: true },
  });
  let projected = 0;
  let excluded = 0;
  for (const issue of issues) {
    const projection = await upsertFleetProjectProjection(issue.repoFullName, issue.number);
    if (projection) projected += 1;
    else excluded += 1;
  }
  return { scanned: issues.length, projected, excluded };
}

/**
 * 공개 scheduler entrypoint. fresh installation/binding readback과 source cohort 수렴이
 * 끝난 뒤에만 private drain을 실행해, 단독 호출이 permission preflight를 건너뛰지 못하게 한다.
 */
export async function reconcileFleetProjectProjections(limit = 20) {
  const binding = await reconcileFleetProjectBinding();
  const sources = await reconcileFleetProjectProjectionSources();
  const projections = await drainFleetProjectProjections(limit);
  return { binding, sources, projections };
}
