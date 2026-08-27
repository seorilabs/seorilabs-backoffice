import type { Prisma } from "@prisma/client";

/** 지연 도착 webhook이 현재 source observation을 덮지 않도록 event time을 우선한다. */
export function latestDiscoveryObservationOrder(): Prisma.DiscoveryObservationOrderByWithRelationInput[] {
  return [
    { observedAt: "desc" },
    { createdAt: "desc" },
    { id: "desc" },
  ];
}
