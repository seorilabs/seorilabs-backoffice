import { Prisma } from "@prisma/client";

import { fleetProjectFieldsSchema } from "@/lib/control-plane/contracts";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { getInstallationOctokit, type Octokit } from "@/lib/github/app";
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

export async function applyFleetProjectProjection(
  projectionId: string,
  octokit?: Octokit,
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
  const projection = await prisma.fleetProjectProjection.findUnique({ where: { id: projectionId } });
  if (!projection) throw new ControlPlaneError("Project projection을 찾을 수 없습니다.", 404, "PROJECTION_NOT_FOUND");
  if (projection.projectNodeId.startsWith("UNCONFIGURED:")) {
    await prisma.fleetProjectProjection.update({
      where: { id: projection.id },
      data: { status: "NEEDS_INPUT", lastError: "Seorilabs Fleet Project node ID가 필요합니다." },
    });
    return { applied: false, skipped: true };
  }
  try {
    const client = octokit ?? await getInstallationOctokit();
    const desired = fleetProjectFieldsSchema.parse(projection.desired);
    const desiredFields = desiredByField(desired);
    const context = await client.graphql<ProjectQuery>(PROJECT_QUERY, {
      projectId: projection.projectNodeId,
      issueId: projection.issueNodeId,
    });
    if (!context.project || !context.issue) {
      throw new ControlPlaneError("Project 또는 Issue node를 읽을 수 없습니다.", 409, "PROJECT_READBACK_MISSING");
    }
    const fields = new Map(
      context.project.fields.nodes
        .filter((field): field is ProjectField => Boolean(field?.id && field.name))
        .map((field) => [field.name, field]),
    );
    for (const name of FIELD_NAMES) {
      if (!fields.has(name)) throw new ControlPlaneError(`Fleet Project field '${name}'이 없습니다.`, 409, "PROJECT_FIELD_MISSING");
    }
    const itemId = await ensureProjectItem(
      client,
      projection.projectNodeId,
      projection.issueNodeId,
      context.issue.projectItems.nodes.find((item): item is ProjectItem => item?.project.id === projection.projectNodeId),
    );
    const before = await readItemValues(client, itemId);
    if (!matchesDesired(before, desiredFields)) {
      for (const [name, value] of Object.entries(desiredFields)) {
        if (value === null && before[name] !== undefined) {
          await clearField({
            octokit: client,
            projectId: projection.projectNodeId,
            itemId,
            fieldId: fields.get(name)!.id,
          });
        } else if (value !== null && before[name] !== value) {
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
    await prisma.fleetProjectProjection.update({
      where: { id: projection.id },
      data: { status: "APPLIED", observed, appliedAt: new Date(), lastError: null },
    });
    return { applied: true, skipped: false };
  } catch (error) {
    await prisma.fleetProjectProjection.update({
      where: { id: projection.id },
      data: {
        status: "READBACK_REQUIRED",
        lastError: error instanceof Error ? error.message.slice(0, 1_000) : "Project projection failed",
        observed: Prisma.DbNull,
      },
    });
    throw error;
  }
}

export async function drainFleetProjectProjections(limit = 20) {
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
      projectNodeId: { not: { startsWith: "UNCONFIGURED:" } },
    },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
    select: { id: true },
  });
  let applied = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await applyFleetProjectProjection(row.id);
      if (result.applied) applied += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: rows.length, applied, failed };
}
