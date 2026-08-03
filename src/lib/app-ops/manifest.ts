import { z } from "zod";

import type { AppContentSpec } from "@/lib/analytics/content-spec";

export const APP_OPS_MANIFEST_PATH = ".seorilabs/backoffice.json";
export const APP_OPS_MANIFEST_VERSION = 1;

export const APP_OPS_SECTIONS = [
  "operations",
  "commerce",
  "ads",
  "content",
  "flags",
] as const;

export type AppOpsSection = (typeof APP_OPS_SECTIONS)[number];

const ident = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "영문, 숫자, 밑줄, 하이픈만 사용할 수 있습니다.");
const analyticsIdent = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_]+$/, "분석 식별자는 영문, 숫자, 밑줄만 사용할 수 있습니다.");
const label = z.string().trim().min(1).max(80);
const description = z.string().trim().min(1).max(300);
const sensitiveInputKey =
  /(?:password|passwd|secret|credential|private[_-]?key|receipt|purchase[_-]?token|signed[_-]?(?:data|payload)|id[_-]?token|access[_-]?token|refresh[_-]?token)/i;

const predicateSchema = z
  .object({
    param: analyticsIdent,
    op: z.enum(["eq", "ne", "ne_or_unset", "gt", "gte", "lt", "lte", "truthy"]),
    value: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const metricSchema = z
  .object({
    key: analyticsIdent,
    label,
    event: z.union([
      analyticsIdent,
      z.array(analyticsIdent).min(1).max(10),
    ]),
    agg: z.enum(["count", "users", "sum", "avg"]),
    param: analyticsIdent.optional(),
    where: z.array(predicateSchema).max(10).optional(),
    unit: z.string().max(16).optional(),
    round: z.number().int().min(0).max(6).optional(),
  })
  .strict()
  .superRefine((metric, ctx) => {
    if ((metric.agg === "sum" || metric.agg === "avg") && !metric.param) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["param"],
        message: `${metric.agg} 집계에는 param이 필요합니다.`,
      });
    }
  });

const derivedSchema = z
  .object({
    key: analyticsIdent,
    label,
    num: analyticsIdent,
    den: analyticsIdent,
    scale: z.number().optional(),
    unit: z.string().max(16).optional(),
    round: z.number().int().min(0).max(6).optional(),
  })
  .strict();

const contentSpecSchema = z
  .object({
    market: z
      .object({
        param: analyticsIdent.optional(),
        platformMap: z
          .object({
            android: ident.optional(),
            ios: ident.optional(),
            web: ident.optional(),
          })
          .strict()
          .optional(),
        values: z
          .array(z.object({ key: ident, label }).strict())
          .min(1)
          .max(10),
      })
      .strict()
      .optional(),
    metrics: z.array(metricSchema).max(80).optional(),
    distributions: z
      .array(
        z
          .object({
            key: analyticsIdent,
            label,
            event: analyticsIdent,
            param: analyticsIdent,
            topN: z.number().int().min(1).max(100).optional(),
            valueLabels: z.record(z.string().max(80)).optional(),
            where: z.array(predicateSchema).max(10).optional(),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    groups: z
      .array(
        z
          .object({
            key: analyticsIdent,
            label,
            param: analyticsIdent,
            metrics: z.array(metricSchema).min(1).max(30),
            derived: z.array(derivedSchema).max(20).optional(),
            valueLabels: z.record(z.string().max(80)).optional(),
            topN: z.number().int().min(1).max(100).optional(),
            orderBy: analyticsIdent.optional(),
            order: z.array(z.string().max(80)).max(100).optional(),
            render: z.enum(["table", "funnel"]).optional(),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    derived: z.array(derivedSchema).max(30).optional(),
  })
  .strict();

const inputSchema = z
  .object({
    key: ident,
    label,
    type: z.enum(["text", "number", "boolean", "select", "textarea"]),
    required: z.boolean().default(true),
    placeholder: z.string().max(120).optional(),
    help: z.string().max(240).optional(),
    options: z
      .array(z.object({ value: z.string().max(80), label }).strict())
      .min(1)
      .max(50)
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.type === "select" && !input.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "select 입력에는 options가 필요합니다.",
      });
    }
    if (sensitiveInputKey.test(input.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["key"],
        message: "비밀번호, 영수증, 토큰, 키 등 비밀 입력은 manifest로 받을 수 없습니다.",
      });
    }
  });

const operationSchema = z
  .object({
    id: ident,
    label,
    description: description.optional(),
    intent: z.enum(["read", "mutate"]),
    risk: z.enum(["low", "medium", "high"]).default("low"),
    confirmation: z.enum(["none", "reason", "typed"]).default("none"),
    inputs: z.array(inputSchema).max(20).default([]),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (operation.intent === "mutate" && operation.confirmation === "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: "변경 오퍼레이션은 reason 또는 typed 확인이 필요합니다.",
      });
    }
    if (operation.risk === "high" && operation.confirmation !== "typed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: "고위험 오퍼레이션은 typed 확인이 필요합니다.",
      });
    }
  });

const toolSchema = z
  .object({
    id: ident,
    section: z.enum(APP_OPS_SECTIONS),
    title: label,
    description,
    runbook: z
      .string()
      .max(240)
      .regex(/^(docs\/|README\.md$)/, "runbook은 저장소의 docs/ 또는 README.md 경로여야 합니다.")
      .optional(),
    operations: z.array(operationSchema).max(20).default([]),
  })
  .strict()
  .superRefine((tool, ctx) => {
    const ids = new Set<string>();
    tool.operations.forEach((operation, index) => {
      if (ids.has(operation.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["operations", index, "id"],
          message: `중복 operation id: ${operation.id}`,
        });
      }
      ids.add(operation.id);
    });
  });

export const appOpsManifestSchema = z
  .object({
    $schema: z.string().max(300).optional(),
    version: z.literal(APP_OPS_MANIFEST_VERSION),
    summary: z.string().trim().min(1).max(200).optional(),
    tools: z.array(toolSchema).max(40).default([]),
    analytics: z
      .object({
        content: contentSpecSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    manifest.tools.forEach((tool, index) => {
      if (ids.has(tool.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tools", index, "id"],
          message: `중복 tool id: ${tool.id}`,
        });
      }
      ids.add(tool.id);
    });
  });

export type AppOpsManifest = z.infer<typeof appOpsManifestSchema>;
export type AppOpsTool = AppOpsManifest["tools"][number];
export type AppOpsOperation = AppOpsTool["operations"][number];
export type AppOpsInput = AppOpsOperation["inputs"][number];

export interface ManifestParseResult {
  manifest: AppOpsManifest | null;
  error: string | null;
}

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue.path.length > 0 ? issue.path.join(".") : "manifest";
  return `${path}: ${issue.message}`;
}

export function parseAppOpsManifest(value: unknown): ManifestParseResult {
  const parsed = appOpsManifestSchema.safeParse(value);
  if (parsed.success) return { manifest: parsed.data, error: null };
  return { manifest: null, error: firstIssueMessage(parsed.error) };
}

export function parseAppOpsManifestText(text: string | null): ManifestParseResult {
  if (text == null) return { manifest: null, error: null };
  try {
    return parseAppOpsManifest(JSON.parse(text));
  } catch {
    return { manifest: null, error: "manifest: 올바른 JSON이 아닙니다." };
  }
}

export function contentSpecFromManifest(
  slug: string,
  manifestValue: unknown,
): AppContentSpec | null {
  const { manifest } = parseAppOpsManifest(manifestValue);
  const content = manifest?.analytics?.content;
  return content ? ({ slug, ...content } as AppContentSpec) : null;
}

export function toolsForSection(
  manifestValue: unknown,
  section: AppOpsSection,
): AppOpsTool[] {
  const { manifest } = parseAppOpsManifest(manifestValue);
  return manifest?.tools.filter((tool) => tool.section === section) ?? [];
}
