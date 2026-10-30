import { z } from "zod";

export const ga4ConnectionSchema = z.object({
  enabled: z.boolean(),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  datasetId: z.string().regex(/^analytics_[0-9]+$/),
}).strict();

/** 모든 소비자는 ACTIVE 설정 한 건을 같은 순서로 읽는다. */
export const activeGa4ConfigSelect = {
  where: { status: "ACTIVE" as const },
  orderBy: { revision: "desc" as const },
  take: 1,
  select: { payload: true },
};
